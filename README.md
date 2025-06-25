#  AWS EC2 + SQS Auto Deployment Script

This project automates the provisioning and deployment of an AWS-based messaging app using:

- **Amazon EC2** for frontend and backend instances
- **Amazon SQS** for message queuing
- **Node.js** scripts to send and poll messages
- **AWS SDK** for JavaScript (v3) to programmatically create AWS infrastructure

---

# Features
- Creates a VPC, subnet, internet gateway, route table, and security group
- Launches two EC2 instances: one to send and one to poll messages
- Automatically generates and saves an EC2 SSH key
- Creates an SQS queue and injects its URL into Node.js scripts
- Installs Node.js on EC2 instances
- Deploys and executes messaging scripts remotely

---

# Architecture


                ┌────────────────────────┐
                │      SQS Queue         │
                │    (MyAppQueue)        │
                └─────────┬──────────────┘
                          ▲
         ┌────────────┐   │   ┌────────────┐
         │ Frontend   │──────▶│ Backend    │
         │ EC2 (send) │       │ EC2 (poll) │
         └────────────┘       └────────────┘


# .env file in project root:

- AWS_ACCESS_KEY_ID=your_access_key
- AWS_SECRET_ACCESS_KEY=your_secret_key
- AWS_REGION=us-east-1

# How to Use
- Install dependencies
- npm install

# Run deployment

- node setup-deploy.js

##  Example Output

```bash
$ node setup-deploy.js
Key saved to ./ec2-auto-key.pem
SQS Queue created: https://sqs.us-east-1.amazonaws.com/123456789012/MyAppQueue
Created VPC: vpc-0abc1234def567890
Internet Gateway attached: igw-0fabc123456defabc
Subnet created: subnet-0abc123456defabc1
Route table created and associated
Waiting for EC2 instances to reach running state...
Installing Node.js on instances...
Scripts deployed to /home/ec2-user/app on both instances
Frontend deployed and sending messages on 54.123.45.67
Backend deployed and polling messages on 3.89.123.45

Queue URL: https://sqs.us-east-1.amazonaws.com/123456789012/MyAppQueue
Frontend IP: 54.123.45.67
Backend IP: 3.89.123.45
SSH Key: ./ec2-auto-key.pem
```

# What Happens
- Creates SQS queue and injects URL into scripts
- Provisions EC2 network and launches instances
- Copies and installs scripts on instances
- Runs:
- sendMessage.js every 10 seconds on frontend
- pollMessage.js in background on backend