import 'dotenv/config';
import {
  EC2Client,
  CreateKeyPairCommand,
  CreateVpcCommand,
  ModifyVpcAttributeCommand,
  CreateSubnetCommand,
  CreateSecurityGroupCommand,
  AuthorizeSecurityGroupIngressCommand,
  RunInstancesCommand,
  DescribeInstancesCommand,
  CreateRouteCommand,
  CreateRouteTableCommand,
  AssociateRouteTableCommand,
  CreateInternetGatewayCommand,
  AttachInternetGatewayCommand,
  waitUntilInstanceRunning,
} from '@aws-sdk/client-ec2';

import {
  SQSClient,
  CreateQueueCommand,
} from '@aws-sdk/client-sqs';

import fs from 'fs';
import { execSync } from 'child_process';

import { fromEnv } from "@aws-sdk/credential-provider-env";

const credentials = fromEnv();
const REGION = process.env.AWS_REGION;
const KEY_NAME = 'ec2-auto-key';
const KEY_FILE = './ec2-auto-key.pem';
const QUEUE_NAME = 'MyAppQueue';

const ec2 = new EC2Client({ region: REGION, credentials });
const sqs = new SQSClient({ region: REGION, credentials });

async function createKeyPair() {
  if (fs.existsSync(KEY_FILE)) {
    console.log(`Key pair already exists: ${KEY_FILE}`);
    return KEY_NAME;
  }
  console.log('Creating EC2 key pair...');
  const { KeyMaterial } = await ec2.send(new CreateKeyPairCommand({ KeyName: KEY_NAME }));
  fs.writeFileSync(KEY_FILE, KeyMaterial, { mode: 0o400 });
  console.log(`Key saved to ${KEY_FILE}`);
  return KEY_NAME;
}

async function createSQSQueue() {
  const { QueueUrl } = await sqs.send(new CreateQueueCommand({ QueueName: QUEUE_NAME }));
  console.log('SQS Queue created:', QueueUrl);
  return QueueUrl;
}

function injectQueueUrl(queueUrl) {
  for (const file of ['sendMessage.js', 'pollMessage.js']) {
    const filePath = `./scripts/${file}`;
    const content = fs.readFileSync(filePath, 'utf-8');
    const updated = content.replace(/__QUEUE_URL__/g, queueUrl);
    fs.writeFileSync(filePath, updated, 'utf-8');
    console.log(`Injected queue URL into ${file}`);
  }
}

async function createInfrastructure(keyName) {
  // 1. Create VPC
  const { Vpc } = await ec2.send(new CreateVpcCommand({ CidrBlock: '10.0.0.0/16' }));
  const vpcId = Vpc.VpcId;
  console.log(`Created VPC: ${vpcId}`);

  await ec2.send(new ModifyVpcAttributeCommand({ VpcId: vpcId, EnableDnsSupport: { Value: true } }));
  await ec2.send(new ModifyVpcAttributeCommand({ VpcId: vpcId, EnableDnsHostnames: { Value: true } }));

  // 2. Create Internet Gateway and attach
  const { InternetGateway } = await ec2.send(new CreateInternetGatewayCommand({}));
  const igwId = InternetGateway.InternetGatewayId;
  await ec2.send(new AttachInternetGatewayCommand({ InternetGatewayId: igwId, VpcId: vpcId }));
  console.log(`Internet Gateway attached: ${igwId}`);

  // 3. Create subnet
  const { Subnet } = await ec2.send(new CreateSubnetCommand({
    VpcId: vpcId,
    CidrBlock: '10.0.1.0/24',
    AvailabilityZone: REGION + 'a',
  }));
  const subnetId = Subnet.SubnetId;
  console.log(`Subnet created: ${subnetId}`);

  // 4. Create route table and associate
  const { RouteTable } = await ec2.send(new CreateRouteTableCommand({ VpcId: vpcId }));
  const routeTableId = RouteTable.RouteTableId;

  await ec2.send(new CreateRouteCommand({
    RouteTableId: routeTableId,
    DestinationCidrBlock: '0.0.0.0/0',
    GatewayId: igwId,
  }));

  await ec2.send(new AssociateRouteTableCommand({
    RouteTableId: routeTableId,
    SubnetId: subnetId,
  }));
  console.log(`Route table created and associated`);

  // 5. Create security group
  const { GroupId } = await ec2.send(new CreateSecurityGroupCommand({
    GroupName: 'EC2SQSGroup',
    Description: 'Allow SSH',
    VpcId: vpcId,
  }));

  await ec2.send(new AuthorizeSecurityGroupIngressCommand({
    GroupId,
    IpPermissions: [
      {
        IpProtocol: 'tcp',
        FromPort: 22,
        ToPort: 22,
        IpRanges: [{ CidrIp: '0.0.0.0/0' }],
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
    ],
  }));

  // 6. Launch EC2 Instances
  const { Instances } = await ec2.send(new RunInstancesCommand({
    ImageId: 'ami-0c101f26f147fa7fd', // Amazon Linux 2
    InstanceType: 't2.micro',
    KeyName: keyName,
    MinCount: 2,
    MaxCount: 2,
    NetworkInterfaces: [{
      AssociatePublicIpAddress: true,
      DeviceIndex: 0,
      SubnetId: subnetId,
      Groups: [GroupId],
    }],
    TagSpecifications: [{
      ResourceType: 'instance',
      Tags: [{ Key: 'Project', Value: 'EC2SQS' }],
    }],
    
  }));

  const instanceIds = Instances.map(i => i.InstanceId);
  console.log('Waiting for EC2 instances to reach running state...');
  await waitUntilInstanceRunning({ client: ec2, maxWaitTime: 180 }, { InstanceIds: instanceIds });

  const { Reservations } = await ec2.send(new DescribeInstancesCommand({ InstanceIds: instanceIds }));
  const ips = Reservations.flatMap(r => r.Instances.map(i => i.PublicIpAddress));
  console.log('EC2 instances ready with IPs:', ips);
  return ips;
}

function deployScript(ip, scriptName, role) {
  const remoteDir = "/home/ec2-user/app";

  try {
    // Ensure remote directory exists
    execSync(`ssh -i ${KEY_FILE} -o StrictHostKeyChecking=no ec2-user@${ip} "mkdir -p ${remoteDir}"`);
    //upload scrips
    execSync(`scp -i ${KEY_FILE} -o StrictHostKeyChecking=no -r ./scripts ec2-user@${ip}:${remoteDir}`);
    const cmd = `
      ssh -i ${KEY_FILE} -o StrictHostKeyChecking=no ec2-user@${ip} <<'ENDSSH'
        cd ${remoteDir}
        sudo yum update -y
        curl -fsSL https://rpm.nodesource.com/setup_18.x | sudo bash -
        sudo yum install -y nodejs
        npm init -y -f
        npm install aws-sdk
        nohup node ${scriptName} > ${role}.log 2>&1 &
        echo "${role} script started"
ENDSSH`;
    execSync(cmd, { stdio: "inherit" });
    console.log(`${role} deployed to ${ip}`);
  } catch (err) {
    console.error(`Error deploying ${role} to ${ip}:`, err.message);
  }
}

(async () => {
  try {
    const keyName = await createKeyPair();
    const queueUrl = await createSQSQueue();
    injectQueueUrl(queueUrl);
    const [frontendIP, backendIP] = await createInfrastructure(keyName);

    deployScript(frontendIP, "sendMessage.js", "Frontend");
    deployScript(backendIP, "pollMessage.js", "Backend");

    console.log("\n All done!");
    console.log("Queue URL:", queueUrl);
    console.log("Frontend IP:", frontendIP);
    console.log("Backend IP:", backendIP);
    console.log(`SSH Key: ${KEY_FILE}`);
  } catch (err) {
    console.error("Setup failed:", err);
  }
})();
