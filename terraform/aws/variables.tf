# ─────────────────────────────────────────────────────────────
# Katra — Input Variables
# ─────────────────────────────────────────────────────────────

# ── General ──────────────────────────────────────────────────

variable "aws_region" {
  description = "AWS region for all resources"
  type        = string
  default     = "us-east-1"
}

variable "project_name" {
  description = "Project name used for resource naming and tagging"
  type        = string
  default     = "katra"
}

variable "environment" {
  description = "Deployment environment (production, staging, dev)"
  type        = string
  default     = "production"

  validation {
    condition     = contains(["production", "staging", "dev"], var.environment)
    error_message = "Environment must be one of: production, staging, dev."
  }
}

# ── Networking ───────────────────────────────────────────────

variable "vpc_cidr" {
  description = "CIDR block for the VPC"
  type        = string
  default     = "10.0.0.0/16"
}

variable "availability_zones" {
  description = "List of availability zones (defaults to first 2 in region)"
  type        = list(string)
  default     = []
}

variable "nat_gateway_count" {
  description = "Number of NAT Gateways (1 = single-AZ, 2 = per-AZ HA)"
  type        = number
  default     = 1
  validation {
    condition     = var.nat_gateway_count >= 1 && var.nat_gateway_count <= 2
    error_message = "NAT Gateway count must be 1 or 2."
  }
}

# ── Compute (ECS Fargate) ────────────────────────────────────

variable "katra_image" {
  description = "ECR image URI for the Katra server (e.g., 123456789.dkr.ecr.us-east-1.amazonaws.com/katra:latest)"
  type        = string
  # No default — must be provided or built separately
}

variable "task_cpu" {
  description = "Fargate task CPU units (256, 512, 1024, 2048, 4096)"
  type        = number
  default     = 512
}

variable "task_memory" {
  description = "Fargate task memory in MiB"
  type        = number
  default     = 1024
}

variable "desired_count" {
  description = "Desired number of ECS tasks"
  type        = number
  default     = 1
}

# ── Secrets & API Keys ──────────────────────────────────────

variable "katra_api_key" {
  description = "API key for authenticating agent connections to Katra"
  type        = string
  sensitive   = true
}

variable "mcp_api_key" {
  description = "API key for MCP endpoint"
  type        = string
  sensitive   = true
  default     = null
}

variable "deepseek_api_key" {
  description = "DeepSeek API key for LLM inference (leave empty for local-only)"
  type        = string
  sensitive   = true
  default     = null
}

variable "jwt_secret" {
  description = "JWT secret for dashboard access (SaaS mode)"
  type        = string
  sensitive   = true
  default     = null
}

# ── LLM Configuration ────────────────────────────────────────

variable "llm_provider" {
  description = "LLM provider: local | openai | anthropic | deepseek | google | custom"
  type        = string
  default     = "deepseek"
}

variable "llm_model" {
  description = "Default LLM model for chat"
  type        = string
  default     = ""
}

variable "embedding_provider" {
  description = "Embeddings provider: local | openai | custom"
  type        = string
  default     = "local"
}

# ── Database ─────────────────────────────────────────────────

variable "docdb_instance_class" {
  description = "DocumentDB instance class"
  type        = string
  default     = "db.r5.large"
}

variable "docdb_engine_version" {
  description = "DocumentDB engine version"
  type        = string
  default     = "5.0.0"
}

variable "database_name" {
  description = "Logical database name within DocumentDB"
  type        = string
  default     = "katra"
}

# ── Redis ────────────────────────────────────────────────────

variable "redis_node_type" {
  description = "ElastiCache Redis node type"
  type        = string
  default     = "cache.t3.micro"
}

variable "redis_engine_version" {
  description = "Redis engine version"
  type        = string
  default     = "7.1"
}

# ── S3 ───────────────────────────────────────────────────────

variable "s3_bucket_name" {
  description = "Override S3 bucket name (defaults to project-env-auto-generated)"
  type        = string
  default     = ""
}

# ── Multi-tenancy ────────────────────────────────────────────

variable "multi_tenant" {
  description = "Enable multi-tenant SaaS mode"
  type        = bool
  default     = false
}

variable "tenant_isolation" {
  description = "Tenant isolation strategy (database | collection-prefix)"
  type        = string
  default     = "database"
}

# ── TLS / ACM ────────────────────────────────────────────────

variable "acm_certificate_arn" {
  description = "ARN of the ACM certificate for the ALB HTTPS listener"
  type        = string
}

# ── Tags ─────────────────────────────────────────────────────

variable "tags" {
  description = "Additional tags applied to all taggable resources"
  type        = map(string)
  default     = {}
}
