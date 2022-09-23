import execa from "execa";

const shell = require("shelljs");
const yaml = require('js-yaml');
const fs = require('fs');

require('dotenv').config();
let doc = {};

const timer = ms => new Promise(res => setTimeout(res, ms))

async function terraformInit() {
    console.log("Executing terraform init...")
    shell.exec(`terraform init`, {
        env: {
            ...process.env,
        }
    });
}

async function terraformApply() {
    console.log("Executing terraform apply...")
    shell.exec(`terraform apply -auto-approve`, {
        env: {
            ...process.env,
        }
    });
}

async function terraformDestroy() {
    console.log("Executing terraform destroy...")
    shell.exec(`terraform destroy -auto-approve`, {
        env: {
            ...process.env,
        }
    });
    // delete local terraform files
    // FIXME see POS-812 https://polygon.atlassian.net/browse/POS-812
    shell.exec(`rm -rf .terraform && rm .terraform.lock.hcl && rm terraform.tfstate && rm terraform.tfstate.backup`)
}

async function terraformOutput() {
    console.log("Executing terraform output...")
    const {stdout} = shell.exec(`terraform output --json`, {
        env: {
            ...process.env,
        }
    });

    return stdout
}

function setConfigValue(key, value) {
    if (value) {
        doc[key] = value;
    }
}

function setConfigList(key, value) {
    if (value) {
        value = value.split(' ').join('')
        const valueArray = value.split(",");
        if (valueArray.length > 0) {
            doc[key] = []
            for (let i = 0; i < valueArray.length; i++) {
                doc[key][i] = valueArray[i];

                if (i === 0) {
                    if (key === 'devnetBorHosts') {
                        setEthURL(valueArray[i]);
                    }
                    if (key === 'devnetBorUsers') {
                        setEthHostUser(valueArray[i]);
                    }
                }
            }
        }
    }
}

function setEthURL(value) {
    if (value) {
        doc['ethURL'] = 'http://' + value + ':9545';
        process.env.ETH_URL = doc['ethURL']
    }
}

function setEthHostUser(value) {
    if (value) {
        doc['ethHostUser'] = value;
        process.env.ETH_HOST_USER = value
    }
}

async function editMaticCliDockerYAMLConfig() {
    console.log("Editing matic-cli docker YAML configs...")

    doc = await yaml.load(fs.readFileSync('./configs/devnet/docker-setup-config.yaml', 'utf8'), undefined);

    setCommonConfigs()
    setEthURL('localhost');
    setEthHostUser('ubuntu');

    fs.writeFile('./configs/devnet/docker-setup-config.yaml', yaml.dump(doc), (err) => {
        if (err) {
            console.log("Error while writing docker YAML configs: \n", err)
            process.exit(1)
        }
    });
}

async function editMaticCliRemoteYAMLConfig() {
    console.log("Editing matic-cli remote YAML configs...")

    doc = await yaml.load(fs.readFileSync('./configs/devnet/remote-setup-config.yaml', 'utf8'), undefined);

    setCommonConfigs()
    setConfigList('devnetBorHosts', process.env.DEVNET_BOR_HOSTS);
    setConfigList('devnetHeimdallHosts', process.env.DEVNET_BOR_HOSTS);
    setConfigList('devnetBorUsers', process.env.DEVNET_BOR_USERS);
    setConfigList('devnetHeimdallUsers', process.env.DEVNET_BOR_USERS);

    fs.writeFile('./configs/devnet/remote-setup-config.yaml', yaml.dump(doc), (err) => {
        if (err) {
            console.log("Error while writing remote YAML configs: \n", err)
            process.exit(1)
        }
    });
}

function setCommonConfigs() {
    setConfigValue('defaultStake', parseInt(process.env.DEFAULT_STAKE));
    setConfigValue('defaultFee', parseInt(process.env.DEFAULT_FEE));
    setConfigValue('borChainId', parseInt(process.env.BOR_CHAIN_ID));
    setConfigValue('heimdallChainId', process.env.HEIMDALL_CHAIN_ID);
    setConfigValue('sprintSize', parseInt(process.env.SPRINT_SIZE));
    setConfigValue('blockNumber', process.env.BLOCK_NUMBER);
    setConfigValue('blockTime', process.env.BLOCK_TIME);
    setConfigValue('borBranch', process.env.BOR_BRANCH);
    setConfigValue('heimdallBranch', process.env.HEIMDALL_BRANCH);
    setConfigValue('contractsBranch', process.env.CONTRACTS_BRANCH);
    setConfigValue('numOfValidators', parseInt(process.env.TF_VAR_VALIDATOR_COUNT));
    setConfigValue('numOfNonValidators', parseInt(process.env.TF_VAR_SENTRY_COUNT));
    setConfigValue('devnetType', process.env.DEVNET_TYPE);
    setConfigValue('ethHostUser', process.env.ETH_HOST_USER);
    setConfigValue('borDockerBuildContext', process.env.BOR_DOCKER_BUILD_CONTENXT);
    setConfigValue('heimdallDockerBuildContext', process.env.HEIMDALL_DOCKER_BUILD_CONTENXT);
}

async function installRequiredSoftwareOnRemoteMachines(ips) {

    let ipsArray = ips.split(' ').join('').split(",")
    let borUsers = doc['devnetBorUsers'].toString().split(' ').join('').split(",")
    let borHosts = doc['devnetBorHosts'].toString().split(' ').join('').split(",")
    let user, ip

    for (let i = 0; i < ipsArray.length; i++) {

        i === 0 ? user = `${doc['ethHostUser']}` : `${borUsers[i]}`
        i === 0 ? ip = `${user}@${ipsArray[i]}` : `${user}@${borHosts[i]}`

        await installCommonPackages(user, ip)

        if (i === 0) {
            await installHostSpecificPackages(ip)

            if (process.env.TF_VAR_DOCKERIZED === 'yes') {
                await installDocker(ip)
            }
        }
    }
}

async function installCommonPackages(user, ip) {
    console.log("Allowing user not to use password...")
    let command = `echo "${user} ALL=(ALL) NOPASSWD:ALL" | sudo tee -a /etc/sudoers && exit`
    await runSshCommand(ip, command)

    console.log("Copying certificate to " + ip + ":~/cert.pem...")
    let src = `${process.env.PEM_FILE_PATH}`
    let dest = `${ip}:~/cert.pem`
    await runScpCommand(src, dest)

    console.log("Adding ssh for " + ip + ":~/cert.pem...")
    command = `sudo chmod 600 ~/cert.pem && eval "$(ssh-agent -s)" && ssh-add ~/cert.pem && exit`
    await runSshCommand(ip, command)

    console.log("Installing required software on remote machine " + ip + "...")

    console.log("Running apt update...")
    command = `sudo apt update -y  && exit`
    await runSshCommand(ip, command)

    console.log("Installing build-essential...")
    command = `sudo apt install build-essential -y && exit`
    await runSshCommand(ip, command)

    console.log("Installing go...")
    command = `wget https://raw.githubusercontent.com/maticnetwork/node-ansible/master/go-install.sh &&
                         bash go-install.sh --remove &&
                         bash go-install.sh &&
                         source /home/ubuntu/.bashrc && exit`
    await runSshCommand(ip, command)

    console.log("Creating symlink for go...")
    command = `sudo ln -sf /home/ubuntu/.go/bin/go /usr/local/bin/go && exit`
    await runSshCommand(ip, command)

    console.log("Installing rabbitmq...")
    command = `sudo apt install rabbitmq-server -y && exit`
    await runSshCommand(ip, command)
}

async function installHostSpecificPackages(ip) {
    console.log("Installing nvm...")
    let command = `curl https://raw.githubusercontent.com/creationix/nvm/master/install.sh | bash &&
                        export NVM_DIR="$HOME/.nvm"
                        [ -s "$NVM_DIR/nvm.sh" ] && \\. "$NVM_DIR/nvm.sh"
                        [ -s "$NVM_DIR/bash_completion" ] && \\. "$NVM_DIR/bash_completion" && 
                        nvm install 10.17.0 && exit`
    await runSshCommand(ip, command)

    console.log("Installing solc...")
    command = `sudo snap install solc && exit`
    await runSshCommand(ip, command)

    console.log("Installing python2...")
    command = `sudo apt install python2 -y && alias python="/usr/bin/python2" && exit`
    await runSshCommand(ip, command)

    console.log("Installing nodejs and npm...")
    command = `sudo apt install nodejs npm -y && exit`
    await runSshCommand(ip, command)

    console.log("Creating symlink for npm and node...")
    command = `sudo ln -sf /home/ubuntu/.nvm/versions/node/v10.17.0/bin/npm /usr/bin/npm &&
                    sudo ln -sf /home/ubuntu/.nvm/versions/node/v10.17.0/bin/node /usr/bin/node &&
                    sudo ln -sf /home/ubuntu/.nvm/versions/node/v10.17.0/bin/npx /usr/bin/npx && exit`
    await runSshCommand(ip, command)

    console.log("Installing ganache-cli...")
    command = `sudo npm install -g ganache-cli -y && exit`
    await runSshCommand(ip, command)
}

async function installDocker(ip) {
    console.log("Removing older versions of docker, if installed...")
    let command = `sudo apt-get remove docker docker-engine docker.io containerd runc -y && exit`
    await runSshCommand(ip, command)

    console.log("Setting docker repository up...")
    command = `sudo apt-get update -y && 
                        sudo apt-get install ca-certificates curl gnupg lsb-release && 
                        sudo mkdir -p /etc/apt/keyrings && 
                        curl -fsSL https://download.docker.com/linux/ubuntu/gpg | sudo gpg --dearmor -o /etc/apt/keyrings/docker.gpg && 
                        echo \\
                        "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.gpg] https://download.docker.com/linux/ubuntu \\
                        $(lsb_release -cs) stable" | sudo tee /etc/apt/sources.list.d/docker.list > /dev/null && exit`
    await runSshCommand(ip, command)

    console.log("Installing docker engine...")
    command = `sudo apt-get update && sudo apt-get install docker-ce docker-ce-cli containerd.io docker-compose-plugin && exit`
    await runSshCommand(ip, command)

    console.log("Verifying docker installation...")
    command = `sudo service docker start && sudo docker run hello-world && exit`
    await runSshCommand(ip, command)

    console.log("Create docker group and add user to it...")
    command = `sudo groupadd docker && sudo usermod -aG docker $USER && exit`
    await runSshCommand(ip, command)

    console.log("Applying changes to docker group and verifying installation...")
    command = `newgrp docker && docker run hello-world && exit`
    await runSshCommand(ip, command)
}


async function prepareMaticCLI(ips) {

    let ipsArray = ips.split(' ').join('').split(",")
    let ip = `${doc['ethHostUser']}@${ipsArray[0]}`

    let maticCliRepo = process.env.MATIC_CLI_REPO
    let maticCliBranch = process.env.MATIC_CLI_BRANCH

    console.log("Git checkout " + maticCliRepo + " and pull branch " + maticCliBranch + " on machine " + ipsArray[0])
    let command = `cd ~ && git clone ${maticCliRepo} && cd matic-cli && git checkout ${maticCliBranch}`
    await runSshCommand(ip, command)

    console.log("Installing matic-cli dependencies...")
    command = `cd ~/matic-cli && npm i`
    await runSshCommand(ip, command)
}

async function runRemoteSetupWithMaticCLI(ips) {

    let ipsArray = ips.split(' ').join('').split(",")
    let ip = `${doc['ethHostUser']}@${ipsArray[0]}`

    console.log("Creating devnet and removing default configs...")
    let command = `cd ~/matic-cli && mkdir devnet && rm configs/devnet/remote-setup-config.yaml`
    await runSshCommand(ip, command)

    console.log("Copying remote matic-cli configurations...")
    let src = `./configs/devnet/remote-setup-config.yaml`
    let dest = `${doc['ethHostUser']}@${ipsArray[0]}:~/matic-cli/configs/devnet/remote-setup-config.yaml`
    await runScpCommand(src, dest)

    console.log("Executing remote setup with matic-cli...")
    command = `cd ~/matic-cli/devnet && ../bin/matic-cli setup devnet -c ../configs/devnet/remote-setup-config.yaml`
    await runSshCommand(ip, command)
}

async function runDockerSetupWithMaticCLI(ips) {

    let ipsArray = ips.split(' ').join('').split(",")
    let ip = `${doc['ethHostUser']}@${ipsArray[0]}`

    console.log("Creating devnet and removing default configs...")
    let command = `cd ~/matic-cli && mkdir devnet && rm configs/devnet/docker-setup-config.yaml`
    await runSshCommand(ip, command)

    console.log("Copying remote matic-cli configurations...")
    let src = `./configs/devnet/docker-setup-config.yaml`
    let dest = `${doc['ethHostUser']}@${ipsArray[0]}:~/matic-cli/configs/devnet/docker-setup-config.yaml`
    await runScpCommand(src, dest)

    console.log("Executing remote setup with matic-cli...")
    command = `cd ~/matic-cli/devnet && ../bin/matic-cli setup devnet -c ../configs/devnet/docker-setup-config.yaml`
    await runSshCommand(ip, command)

    // TODO start ganache, start all heimdall, setup bor, start bor
}

async function runSshCommand(ip, command) {
    try {
        await execa('ssh', [
                `-o`, `StrictHostKeyChecking=no`, `-o`, `UserKnownHostsFile=/dev/null`,
                ip,
                command],
            {stdio: 'inherit'})
    } catch (error) {
        console.log("Error while executing command: '" + command + "' : \n", error)
        process.exit(1)
    }
}

async function runScpCommand(src, dest) {
    try {
        await execa('scp', [
            `-o`, `StrictHostKeyChecking=no`, `-o`, `UserKnownHostsFile=/dev/null`,
            src,
            dest
        ], {stdio: 'inherit'})
    } catch (error) {
        console.log("Error while copying '" + src + "' to '" + dest + "': \n", error)
        process.exit(1)
    }
}

// start CLI
export async function cli(args) {
    console.log("Using Express CLI 🚀");

    switch (args[2]) {
        case "--start":

            await terraformApply();

            let tfOutput = await terraformOutput();
            let ips = JSON.parse(tfOutput).instance_ips.value.toString();
            process.env.DEVNET_BOR_HOSTS = ips;

            if (process.env.TF_VAR_DOCKERIZED === 'yes') {
                await editMaticCliDockerYAMLConfig();
            } else {
                await editMaticCliRemoteYAMLConfig();
            }

            console.log("Waiting 10s for the VM to initialize...")
            await timer(10000)

            await installRequiredSoftwareOnRemoteMachines(ips)

            await prepareMaticCLI(ips)

            if (process.env.TF_VAR_DOCKERIZED === 'yes') {
                await runDockerSetupWithMaticCLI(ips)
            } else {
                await runRemoteSetupWithMaticCLI(ips);
            }
            break;

        case "--destroy":
            await terraformDestroy();
            break;

        case "--init":
            await terraformInit();
            break;

        // TODO >>> add an option to rebuild & restart heimdall/bor on all remote nodes

        default:
            console.log("Please use --init or --start or --destroy");
            break;
    }
}

