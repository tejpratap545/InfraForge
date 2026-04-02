/**
 * Maps human-readable service names / aliases to CloudFormation resource type strings.
 * The planner LLM outputs these directly; this registry is used for validation + fallback.
 *
 * Full list: https://docs.aws.amazon.com/cloudcontrolapi/latest/userguide/supported-resources.html
 */

export const RESOURCE_TYPE_MAP: Record<string, string> = {
  // Compute
  "ec2":              "AWS::EC2::Instance",
  "instance":         "AWS::EC2::Instance",
  "eks":              "AWS::EKS::Cluster",
  "kubernetes":       "AWS::EKS::Cluster",
  "k8s":              "AWS::EKS::Cluster",
  "ecs":              "AWS::ECS::Cluster",
  "lambda":           "AWS::Lambda::Function",
  "function":         "AWS::Lambda::Function",
  "asg":              "AWS::AutoScaling::AutoScalingGroup",
  "autoscaling":      "AWS::AutoScaling::AutoScalingGroup",

  // Storage
  "s3":               "AWS::S3::Bucket",
  "bucket":           "AWS::S3::Bucket",
  "dynamodb":         "AWS::DynamoDB::Table",
  "table":            "AWS::DynamoDB::Table",
  "efs":              "AWS::EFS::FileSystem",
  "fsx":              "AWS::FSx::FileSystem",

  // Database
  "rds":              "AWS::RDS::DBInstance",
  "database":         "AWS::RDS::DBInstance",
  "aurora":           "AWS::RDS::DBCluster",
  "elasticache":      "AWS::ElastiCache::CacheCluster",
  "redis":            "AWS::ElastiCache::CacheCluster",
  "memcached":        "AWS::ElastiCache::CacheCluster",

  // Networking
  "vpc":              "AWS::EC2::VPC",
  "subnet":           "AWS::EC2::Subnet",
  "securitygroup":    "AWS::EC2::SecurityGroup",
  "sg":               "AWS::EC2::SecurityGroup",
  "alb":              "AWS::ElasticLoadBalancingV2::LoadBalancer",
  "nlb":              "AWS::ElasticLoadBalancingV2::LoadBalancer",
  "loadbalancer":     "AWS::ElasticLoadBalancingV2::LoadBalancer",
  "elb":              "AWS::ElasticLoadBalancingV2::LoadBalancer",
  "route53":          "AWS::Route53::HostedZone",
  "hostedzone":       "AWS::Route53::HostedZone",
  "cloudfront":       "AWS::CloudFront::Distribution",
  "apigateway":       "AWS::ApiGateway::RestApi",
  "api":              "AWS::ApiGatewayV2::Api",
  "igw":              "AWS::EC2::InternetGateway",
  "natgateway":       "AWS::EC2::NatGateway",
  "transitgateway":   "AWS::EC2::TransitGateway",

  // Containers
  "ecr":              "AWS::ECR::Repository",
  "repository":       "AWS::ECR::Repository",

  // Messaging
  "sqs":              "AWS::SQS::Queue",
  "queue":            "AWS::SQS::Queue",
  "sns":              "AWS::SNS::Topic",
  "topic":            "AWS::SNS::Topic",
  "eventbridge":      "AWS::Events::EventBus",
  "kinesis":          "AWS::Kinesis::Stream",
  "firehose":         "AWS::KinesisFirehose::DeliveryStream",

  // Security & Identity
  "iam":              "AWS::IAM::Role",
  "role":             "AWS::IAM::Role",
  "iamuser":          "AWS::IAM::User",
  "iampolicy":        "AWS::IAM::ManagedPolicy",
  "kms":              "AWS::KMS::Key",
  "secret":           "AWS::SecretsManager::Secret",
  "secretsmanager":   "AWS::SecretsManager::Secret",
  "ssm":              "AWS::SSM::Parameter",
  "parameter":        "AWS::SSM::Parameter",
  "acm":              "AWS::CertificateManager::Certificate",
  "certificate":      "AWS::CertificateManager::Certificate",
  "waf":              "AWS::WAFv2::WebACL",
  "guardduty":        "AWS::GuardDuty::Detector",

  // DevOps
  "cloudformation":   "AWS::CloudFormation::Stack",
  "stack":            "AWS::CloudFormation::Stack",
  "codepipeline":     "AWS::CodePipeline::Pipeline",
  "codebuild":        "AWS::CodeBuild::Project",
  "codecommit":       "AWS::CodeCommit::Repository",

  // Observability
  "cloudwatch":       "AWS::CloudWatch::Alarm",
  "alarm":            "AWS::CloudWatch::Alarm",
  "loggroup":         "AWS::Logs::LogGroup",
  "logs":             "AWS::Logs::LogGroup",
  "dashboard":        "AWS::CloudWatch::Dashboard",

  // Data & Analytics
  "glue":             "AWS::Glue::Database",
  "athena":           "AWS::Athena::WorkGroup",
  "redshift":         "AWS::Redshift::Cluster",
  "opensearch":       "AWS::OpenSearchService::Domain",
  "elasticsearch":    "AWS::OpenSearchService::Domain",
  "emr":              "AWS::EMR::Cluster",
};

/**
 * Resolve a human alias or CloudFormation type string to a canonical CF type.
 * Falls back to the input as-is (allowing direct "AWS::X::Y" strings).
 */
export function resolveResourceType(nameOrType: string): string {
  if (nameOrType.includes("::")) return nameOrType; // already a CF type
  return RESOURCE_TYPE_MAP[nameOrType.toLowerCase().replace(/[^a-z0-9]/g, "")] ?? nameOrType;
}

/**
 * Build a list of CloudFormation type strings from a list of names/aliases/CF types.
 */
export function buildResourceTypeList(names: string[]): string[] {
  return [...new Set(names.map(resolveResourceType))];
}

/**
 * Human-readable description of what a CF type does — used in planner prompt.
 */
export const RESOURCE_CATALOG = `
SUPPORTED RESOURCE TYPES (alias → AWS::Service::Resource):
  ec2 / instance      → AWS::EC2::Instance          (EC2 instances)
  eks / k8s           → AWS::EKS::Cluster            (Kubernetes clusters)
  ecs                 → AWS::ECS::Cluster             (ECS clusters)
  ecr / repository    → AWS::ECR::Repository          (container repos)
  lambda / function   → AWS::Lambda::Function         (Lambda functions)
  asg / autoscaling   → AWS::AutoScaling::AutoScalingGroup
  s3 / bucket         → AWS::S3::Bucket
  dynamodb / table    → AWS::DynamoDB::Table
  rds / database      → AWS::RDS::DBInstance
  aurora              → AWS::RDS::DBCluster
  elasticache / redis → AWS::ElastiCache::CacheCluster
  vpc                 → AWS::EC2::VPC
  subnet              → AWS::EC2::Subnet
  sg / securitygroup  → AWS::EC2::SecurityGroup
  alb / elb           → AWS::ElasticLoadBalancingV2::LoadBalancer
  apigateway / api    → AWS::ApiGatewayV2::Api
  route53 / hostedzone→ AWS::Route53::HostedZone
  cloudfront          → AWS::CloudFront::Distribution
  sqs / queue         → AWS::SQS::Queue
  sns / topic         → AWS::SNS::Topic
  kinesis             → AWS::Kinesis::Stream
  eventbridge         → AWS::Events::EventBus
  iam / role          → AWS::IAM::Role
  kms                 → AWS::KMS::Key
  secret              → AWS::SecretsManager::Secret
  ssm / parameter     → AWS::SSM::Parameter
  cloudformation/stack→ AWS::CloudFormation::Stack
  cloudwatch / alarm  → AWS::CloudWatch::Alarm
  logs / loggroup     → AWS::Logs::LogGroup
  redshift            → AWS::Redshift::Cluster
  opensearch          → AWS::OpenSearchService::Domain
  glue                → AWS::Glue::Database
  codepipeline        → AWS::CodePipeline::Pipeline
  waf                 → AWS::WAFv2::WebACL

  Or use any CloudFormation type directly: AWS::Service::Resource
`;
