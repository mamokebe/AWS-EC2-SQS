// utils/iamUtils.js
import {
  IAMClient,
  CreateRoleCommand,
  PutRolePolicyCommand,
  CreateInstanceProfileCommand,
  AddRoleToInstanceProfileCommand
} from "@aws-sdk/client-iam";
import {
  EC2Client,
  AssociateIamInstanceProfileCommand,
} from "@aws-sdk/client-ec2";
import { SQSClient, GetQueueAttributesCommand } from "@aws-sdk/client-sqs";

import 'dotenv/config';

import { fromEnv } from "@aws-sdk/credential-provider-env";

const credentials = fromEnv();
const REGION = process.env.AWS_REGION;

const iam = new IAMClient({ region: REGION, credentials });
const sqs = new SQSClient({ region: REGION, credentials });
const ec2 = new EC2Client({ region:  REGION, credentials });

export async function attachIamRoleToInstance({
  instanceId,
  queueUrl,
  action = "SendMessage", // or "ReceiveMessage"
  roleName = "EC2SQSRole",
  profileName = "EC2SQSProfile"
}) {
  const sanitizedQueueName = queueUrl.split("/").pop(); // MyAppQueue
  const policyName = `AllowSQS-${Array.isArray(action) ? action.join("-") : action}-${sanitizedQueueName}`.replace(/[^a-zA-Z0-9+=,.@_-]/g, '');


  // 1. Get Queue ARN
  const attrs = await sqs.send(new GetQueueAttributesCommand({
    QueueUrl: queueUrl,
    AttributeNames: ["QueueArn"],
  }));
  const queueArn = attrs.Attributes.QueueArn;

  // 2. Create Role
  try {
    console.log(`Creating IAM Role '${roleName}'...`);
    await iam.send(new CreateRoleCommand({
      RoleName: roleName,
      AssumeRolePolicyDocument: JSON.stringify({
        Version: "2012-10-17",
        Statement: [{
          Effect: "Allow",
          Principal: { Service: "ec2.amazonaws.com" },
          Action: "sts:AssumeRole",
        }],
      }),
    }));
  } catch (err) {
    if (err.name !== "EntityAlreadyExists") throw err;
    console.warn(`IAM Role '${roleName}' already exists.`);
  }

  // 3. Attach SQS Policy
  const actions = Array.isArray(action) ? action : [action];
  await iam.send(new PutRolePolicyCommand({
    RoleName: roleName,
    PolicyName: policyName,
    PolicyDocument: JSON.stringify({
      Version: "2012-10-17",
      Statement: [{
        Effect: "Allow",
        Action: actions,
        Resource: queueArn,
      }],
    }),
  }));

  // 4. Create Instance Profile
  try {
    console.log(`Creating Instance Profile ...`);
    await iam.send(new CreateInstanceProfileCommand({
      InstanceProfileName: profileName,
    }));
  } catch (err) {
    if (err.name !== "EntityAlreadyExistsException" && err.code !=="EntityAlreadyExists") {throw err};

    console.warn(`Instance Profile '${profileName}' already exists.`);
  }
  
  //5  Add role to instance profile
  try {
  console.log(`Adding role '${roleName}' to instance profile '${profileName}'...`);
  // This will throw if the role is already associated with the profile
    await iam.send(new AddRoleToInstanceProfileCommand({
    InstanceProfileName: profileName,
    RoleName: roleName,
  }));
  } catch (err) {
    if (!err.message.includes("cannot be added")) throw err;
    console.warn(`Role '${roleName}' already associated with profile.`);
    
  }
  

  // 6. Attach Instance Profile
  console.log(`Attaching instance profile to instance ${instanceId}...`);
  await new Promise(res => setTimeout(res, 10000)); // IAM consistency delay

  await ec2.send(new AssociateIamInstanceProfileCommand({
    InstanceId: instanceId,
    IamInstanceProfile: { Name: profileName },
  }));

  console.log(`IAM Role '${roleName}' attached to instance ${instanceId}`);
}
