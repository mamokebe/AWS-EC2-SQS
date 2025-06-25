import {
  EC2Client,
  DescribeInstancesCommand,
  TerminateInstancesCommand,
  DeleteKeyPairCommand,
  DescribeVpcsCommand,
  DeleteVpcCommand,
  DescribeSubnetsCommand,
  DeleteSubnetCommand,
  DescribeInternetGatewaysCommand,
  DetachInternetGatewayCommand,
  DeleteInternetGatewayCommand,
  DescribeRouteTablesCommand,
  DeleteRouteTableCommand,
  DescribeSecurityGroupsCommand,
  DeleteSecurityGroupCommand,
} from "@aws-sdk/client-ec2";

import {
  SQSClient,
  DeleteQueueCommand,
  ListQueuesCommand
} from "@aws-sdk/client-sqs";

import { fromEnv } from "@aws-sdk/credential-provider-env";
import 'dotenv/config';
const credentials = fromEnv();
const REGION = process.env.AWS_REGION;
const ec2 = new EC2Client({ region: REGION, credentials });
const sqs = new SQSClient({ region: REGION , credentials });

const keyName = "ec2-auto-key";
const queueName = "MyAppQueue";

async function destroyAllResources() {
  try {
    // 1. Terminate EC2 Instances
    const instances = await ec2.send(new DescribeInstancesCommand({}));
    const instanceIds = instances.Reservations.flatMap(r => r.Instances.map(i => i.InstanceId));
    if (instanceIds.length > 0) {
      await ec2.send(new TerminateInstancesCommand({ InstanceIds: instanceIds }));
      console.log("Terminating EC2 instances:", instanceIds);
    }

    // 2. Delete Key Pair
    await ec2.send(new DeleteKeyPairCommand({ KeyName: keyName }));
    console.log(`Key pair '${keyName}' deleted`);

    // 3. Delete Security Groups (excluding default)
    const secGroups = await ec2.send(new DescribeSecurityGroupsCommand({}));
    for (const sg of secGroups.SecurityGroups) {
      if (!sg.GroupName.includes("default")) {
        await ec2.send(new DeleteSecurityGroupCommand({ GroupId: sg.GroupId }));
        console.log(`Security group ${sg.GroupId} deleted`);
      }
    }

    // 4. Delete Route Tables (excluding main)
    const routeTables = await ec2.send(new DescribeRouteTablesCommand({}));
    for (const rt of routeTables.RouteTables) {
      if (!rt.Associations.some(a => a.Main)) {
        await ec2.send(new DeleteRouteTableCommand({ RouteTableId: rt.RouteTableId }));
        console.log(`Route table ${rt.RouteTableId} deleted`);
      }
    }

    // 5. Detach and delete Internet Gateways
    const igws = await ec2.send(new DescribeInternetGatewaysCommand({}));
    for (const igw of igws.InternetGateways) {
      for (const attachment of igw.Attachments) {
        await ec2.send(new DetachInternetGatewayCommand({
          InternetGatewayId: igw.InternetGatewayId,
          VpcId: attachment.VpcId
        }));
      }
      await ec2.send(new DeleteInternetGatewayCommand({ InternetGatewayId: igw.InternetGatewayId }));
      console.log(`Internet Gateway ${igw.InternetGatewayId} deleted`);
    }

    // 6. Delete Subnets
    const subnets = await ec2.send(new DescribeSubnetsCommand({}));
    for (const sn of subnets.Subnets) {
      await ec2.send(new DeleteSubnetCommand({ SubnetId: sn.SubnetId }));
      console.log(`Subnet ${sn.SubnetId} deleted`);
    }

    // 7. Delete VPCs (excluding default)
    const vpcs = await ec2.send(new DescribeVpcsCommand({}));
    for (const vpc of vpcs.Vpcs) {
      if (!vpc.IsDefault) {
        await ec2.send(new DeleteVpcCommand({ VpcId: vpc.VpcId }));
        console.log(`VPC ${vpc.VpcId} deleted`);
      }
    }

    // 8. Delete SQS Queue
    const queues = await sqs.send(new ListQueuesCommand({}));
    for (const url of queues.QueueUrls || []) {
      if (url.endsWith(queueName)) {
        await sqs.send(new DeleteQueueCommand({ QueueUrl: url }));
        console.log(`SQS Queue ${url} deleted`);
      }
    }

    console.log("\n All AWS resources cleaned up successfully.");

  } catch (err) {
    console.error("Cleanup failed:", err.message || err);
  }
}

await destroyAllResources();

//this script with caution, as it will delete all resources in your AWS account that match the criteria specified in the script. Make sure to run it in a test environment or with resources you are okay with deleting.

// Note: This script assumes that the AWS credentials and region are set in the environment variables.
// Make sure to set AWS_REGION and AWS_ACCESS_KEY_ID, AWS_SECRET_ACCESS_KEY before running this script.
// You can set these in your terminal or in a .env file if you're using dotenv package.

// Example usage:
// node destroy-all.js
// This will clean up all resources created by the previous scripts in this project.