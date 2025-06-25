const { SQSClient, SendMessageCommand } = require("@aws-sdk/client-sqs");
const { fromEnv } = require("@aws-sdk/credential-provider-env");

// Load AWS credentials from environment variables
const credentials = fromEnv();

// Replace this line with the correct injected URL
let QUEUE_URL = "https://sqs.us-east-1.amazonaws.com/841247451028/MyAppQueue"; // This should be replaced with the actual queue URL dynamically";

// Create the SQS client
const client = new SQSClient({ region: "us-east-1" });

module.exports = async function () {
  try {
    const result = await client.send(new SendMessageCommand({
      QueueUrl: QUEUE_URL,
      MessageBody: `Hello at ${new Date().toISOString()}`
    }));
    console.log("Message sent:", result.MessageId);
  } catch (err) {
    console.error("Error sending message:", err);
  }
};
