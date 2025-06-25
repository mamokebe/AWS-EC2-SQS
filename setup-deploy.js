import {
  EC2Client, CreateKeyPairCommand, CreateVpcCommand, 
  CreateInternetGatewayCommand,AttachInternetGatewayCommand, 
  CreateSubnetCommand, CreateRouteTableCommand,
  CreateRouteCommand, AssociateRouteTableCommand, AuthorizeSecurityGroupIngressCommand,
  CreateSecurityGroupCommand, RunInstancesCommand, 
  waitUntilInstanceRunning,
  DescribeInstancesCommand,
} from "@aws-sdk/client-ec2";
import {
  SQSClient, CreateQueueCommand
} from "@aws-sdk/client-sqs";
import fs from "fs";
import net from "net";
import { attachIamRoleToInstance } from "./utils/iamUtils.js";
import 'dotenv/config';

import { execSync } from "child_process";

import { fromEnv } from "@aws-sdk/credential-provider-env";

const credentials = fromEnv();
const REGION = process.env.AWS_REGION;
const ec2 = new EC2Client({ region: REGION, credentials });
const sqs = new SQSClient({ region: REGION, credentials });

const keyName = "ec2-auto-key";
const queueName = "MyAppQueue";
const keyPath = "./ec2-auto-key.pem";
const remoteDir = "/home/ec2-user/app";

async function createInfrastructure() {
  const key = await ec2.send(new CreateKeyPairCommand({ KeyName: keyName }));
  fs.writeFileSync(keyPath, key.KeyMaterial, { mode: 0o400 });
  console.log("Key saved to", keyPath);

  const createQueue = await sqs.send(new CreateQueueCommand({ QueueName: queueName }));
  const queueUrl = createQueue.QueueUrl;
  console.log("SQS Queue created:", queueUrl);

  const injectQueueUrl = (file) => {
    const scriptPath = `./scripts/${file}`;
    const code = fs.readFileSync(scriptPath, "utf-8");
    const updated = code.replace(/QUEUE_URL\s*=\s*["'].*?["']/, `QUEUE_URL = "${queueUrl}"`);
    fs.writeFileSync(scriptPath, updated);
  };
  injectQueueUrl("sendMessage.js");
  injectQueueUrl("pollMessage.js");

  const vpcData = await ec2.send(new CreateVpcCommand({ CidrBlock: "10.0.0.0/16" }));
  const vpcId = vpcData.Vpc.VpcId;
  console.log("Created VPC:", vpcId);

  const igw = await ec2.send(new CreateInternetGatewayCommand({}));
  const igwId = igw.InternetGateway.InternetGatewayId;
  await ec2.send(new AttachInternetGatewayCommand({ InternetGatewayId: igwId, VpcId: vpcId }));
  console.log("Internet Gateway attached:", igwId);

  const subnet = await ec2.send(new CreateSubnetCommand({ VpcId: vpcId, CidrBlock: "10.0.1.0/24" }));
  const subnetId = subnet.Subnet.SubnetId;
  console.log("Subnet created:", subnetId);

  const rt = await ec2.send(new CreateRouteTableCommand({ VpcId: vpcId }));
  const rtId = rt.RouteTable.RouteTableId;
  await ec2.send(new CreateRouteCommand({ RouteTableId: rtId, DestinationCidrBlock: "0.0.0.0/0", GatewayId: igwId }));
  await ec2.send(new AssociateRouteTableCommand({ RouteTableId: rtId, SubnetId: subnetId }));
  console.log("Route table created and associated");

  const sg = await ec2.send(new CreateSecurityGroupCommand({
    GroupName: "sqs-app-sg",
    Description: "Allow SSH",
    VpcId: vpcId
  }));
  const sgId = sg.GroupId;
  await ec2.send(new AuthorizeSecurityGroupIngressCommand({
    GroupId: sgId,
    IpPermissions: [
      { 
      IpProtocol: "tcp", 
      FromPort: 22, 
      ToPort: 22, 
      IpRanges: [{ CidrIp: "0.0.0.0/0" }] 
    },
    {
        IpProtocol: "tcp",
        FromPort: 80,
        ToPort: 80,
        IpRanges: [{ CidrIp: "0.0.0.0/0" }],
      }, 
      {
        IpProtocol: "tcp",
        FromPort: 443,
        ToPort: 443,
        IpRanges: [{ CidrIp: "0.0.0.0/0" }],
      },
    ]
  }));

  // 3. Launch EC2 Instances (frontend and backend)
    console.log("Launching EC2 instances...");
    const backendInstance = await ec2.send(new RunInstancesCommand({
      ImageId: "ami-0c2b8ca1dad447f8a", // Amazon Linux 2
      InstanceType: "t2.micro",
      MinCount: 1,
      MaxCount: 1,
      KeyName: keyName,
      NetworkInterfaces: [{
        AssociatePublicIpAddress: true,
        DeviceIndex: 0,
        SubnetId: subnetId,
        Groups: [sgId]
      }],
      TagSpecifications: [{
        ResourceType: "instance",
        Tags: [{ Key: "Name", Value: " " }]
      }]
    }));

    const  frontendInstance= await ec2.send(new RunInstancesCommand({
      ImageId: "ami-0c2b8ca1dad447f8a",
      InstanceType: "t2.micro",
      MinCount: 1,
      MaxCount: 1,
      KeyName: keyName,
      NetworkInterfaces: [{
        AssociatePublicIpAddress: true,
        DeviceIndex: 0,
        SubnetId: subnetId,
        Groups: [sgId]
      }],
      TagSpecifications: [{
        ResourceType: "instance",
        Tags: [{ Key: "Name", Value: "" }]
      }]
    }));

    const frontendInstanceId = frontendInstance.Instances[0].InstanceId;
    const backendInstanceId = backendInstance.Instances[0].InstanceId;

    // 4. Wait until both are running
    await waitUntilInstanceRunning({ client: ec2, maxWaitTime: 180 }, { InstanceIds: [frontendInstanceId, backendInstanceId] });

    const describe = await ec2.send(new DescribeInstancesCommand({ InstanceIds: [frontendInstanceId, backendInstanceId] }));
    const frontendIp = describe.Reservations[0].Instances[0].PublicIpAddress;
    const backendIp = describe.Reservations[1].Instances[0].PublicIpAddress;
    console.log("Frontend IP:", frontendIp);
    console.log("Backend IP:", backendIp);

    // 5. Attach IAM Roles to each instance
    await attachIamRoleToInstance({
      instanceId: frontendInstanceId,
      queueUrl: queueUrl,
      action: "sqs:SendMessage",
      roleName: "FrontendSQSRole",
      profileName: "FrontendProfile"
    });

    await attachIamRoleToInstance({
      instanceId: backendInstanceId,
      queueUrl: queueUrl,
      action: ["sqs:ReceiveMessage", "sqs:DeleteMessage"],
      roleName: "BackendSQSRole",
      profileName: "BackendProfile"
    });
    return { queueUrl, frontendIp, backendIp, keyPath, frontendInstanceId, backendInstanceId };
}

//run the infrastructure creation and return the queue URL and instance IPs
const { queueUrl, frontendIp, backendIp} = await createInfrastructure();

// Function to wait for SSH to be available on the instance
async function waitForSSH(ip, port = 22, timeout = 300000) {
  const start = Date.now();
  return new Promise((resolve, reject) => {
    const tryConnect = () => {
      const socket = net.connect(port, ip);
      socket
        .on('connect', () => {
          socket.end();
          console.log(`SSH is available at ${ip}`);
          resolve(true);
        })
        .on('error', () => {
          if (Date.now() - start > timeout) {
            reject(new Error(`Timeout waiting for SSH at ${ip}`));
          } else {
            console.log(`Waiting for SSH at ${ip}...`);
            setTimeout(tryConnect, 5000);
          }
        });
    };
    tryConnect();
  });
}

function retryCommand(cmd, maxRetries = 5, delayMs = 10000) {
  for (let i = 0; i < maxRetries; i++) {
    try {
      execSync(cmd, { stdio: "inherit" });
      return; // success
    } catch (err) {
      console.warn(`Retry ${i + 1}/${maxRetries} failed: ${err.message}`);
      if (i === maxRetries - 1) throw err;
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, delayMs); // sleep
    }
  }
}
(async () => {
try {
  console.log("Waiting for EC2 instances to reach SSH-ready state...");
    await waitForSSH(frontendIp);
    await waitForSSH(backendIp);
  console.log("Installing Node.js on instances...");

  // Install Node.js on frontend and backend instances
  retryCommand(`ssh -i ${keyPath} -o StrictHostKeyChecking=no ec2-user@${frontendIp} "curl -fsSL https://rpm.nodesource.com/setup_16.x | sudo bash - && sudo yum install -y nodejs"`);
  retryCommand(`ssh -i ${keyPath} -o StrictHostKeyChecking=no ec2-user@${backendIp} "curl -fsSL https://rpm.nodesource.com/setup_16.x | sudo bash - && sudo yum install -y nodejs"`);

  // Create remote directory on both instances
  execSync(`ssh -i ${keyPath} -o StrictHostKeyChecking=no ec2-user@${frontendIp} "mkdir -p ${remoteDir}"`);
  execSync(`ssh -i ${keyPath} -o StrictHostKeyChecking=no ec2-user@${backendIp} "mkdir -p ${remoteDir}"`);

  // Copy scripts directory to both instances
  execSync(`scp -i ${keyPath} -o StrictHostKeyChecking=no -r ./scripts ec2-user@${frontendIp}:${remoteDir}`);
  execSync(`scp -i ${keyPath} -o StrictHostKeyChecking=no -r ./scripts ec2-user@${backendIp}:${remoteDir}`);

  // Copy package*.json files separately (redundant if already in ./scripts, but kept here as in your original code)
  execSync(`scp -i ${keyPath} -o StrictHostKeyChecking=no ./scripts/package*.json ec2-user@${frontendIp}:${remoteDir}/scripts`);
  execSync(`scp -i ${keyPath} -o StrictHostKeyChecking=no ./scripts/package*.json ec2-user@${backendIp}:${remoteDir}/scripts`);

  // Install npm dependencies on both instances
  execSync(`ssh -i ${keyPath} -o StrictHostKeyChecking=no ec2-user@${frontendIp} "cd ${remoteDir}/scripts && npm install"`);
  execSync(`ssh -i ${keyPath} -o StrictHostKeyChecking=no ec2-user@${backendIp} "cd ${remoteDir}/scripts && npm install"`);

  console.log(`Scripts deployed to ${remoteDir} on both instances.`);

  // Start the frontend autoSend.js loop
  execSync(`ssh -i ${keyPath} -o StrictHostKeyChecking=no ec2-user@${frontendIp} "cd ${remoteDir} && echo 'let i = 0; const interval = setInterval(() => { require(\\\"./scripts/sendMessage\\\")(); if (++i >= 10) clearInterval(interval); }, 10000);' > autoSend.js && nohup node autoSend.js > autoSend.log 2>&1 &"`);

  console.log(`Frontend deployed and sending messages on ${frontendIp}`);

  // Start the backend pollMessage.js script in background with logs
  execSync(`ssh -i ${keyPath} -o StrictHostKeyChecking=no ec2-user@${backendIp} "cd ${remoteDir} && nohup node scripts/pollMessage.js > poll.log 2>&1 &"`);

  console.log(`Backend deployed and polling messages on ${backendIp}`);

  // Summary
  console.log(`\n Deployment Summary:`);
  console.log(` Queue URL: ${queueUrl}`);
  console.log(` Frontend IP: ${frontendIp}`);
  console.log(` Backend IP: ${backendIp}`);
  console.log(` SSH Key: ${keyPath}`);

} catch (err) {
  console.error("Deployment failed:", err.message || err);
}
})();
console.log("Deployment completed successfully.");

// Note: Ensure that the AWS credentials are set in your environment variables
// and that the necessary permissions are granted for the operations performed in this script.