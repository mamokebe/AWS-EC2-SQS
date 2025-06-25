const { SQSClient, ReceiveMessageCommand, DeleteMessageCommand } = require("@aws-sdk/client-sqs");

const { fromEnv } = require("@aws-sdk/credential-provider-env");

// Load AWS credentials from environment variables
const credentials = fromEnv();

// Replace this line with the correct injected URL
let QUEUE_URL = "https://sqs.us-east-1.amazonaws.com/841247451028/MyAppQueue"; // This should be replaced with the actual queue URL dynamically";

// Create the SQS client
const client = new SQSClient({ region: "us-east-1" });

async function pollMessages() {
  console.log("Polling for messages...");
  while (true) {
    try {
      const { Messages } = await client.send(new ReceiveMessageCommand({
        QueueUrl: QUEUE_URL,
        MaxNumberOfMessages: 1,
        WaitTimeSeconds: 10
      }));

      if (Messages && Messages.length > 0) {
        for (const msg of Messages) {
          console.log("Received:", msg.Body);
          await client.send(new DeleteMessageCommand({
            QueueUrl: QUEUE_URL,
            ReceiptHandle: msg.ReceiptHandle
          }));
          console.log("Deleted message");
        }
      }
    } catch (err) {
      console.error(" Polling error:", err);
    }
  }
}

pollMessages();
