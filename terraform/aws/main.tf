# ─────────────────────────────────────────────────────────────
# Katra — Cognitive Memory as a Service (AWS Infrastructure)
# ─────────────────────────────────────────────────────────────
#
# Services:
#   • VPC (2+ AZs, public/private subnets)
#   • ECS Fargate  →  Katra server (REST :9002 / MCP :3100)
#   • DocumentDB   →  MongoDB-compatible persistence
#   • ElastiCache  →  Redis caching layer
#   • S3           →  Asset / object storage
#   • ALB          →  Path-based routing + TLS termination
#   • Secrets Mgr  →  API keys, DB credentials
#   • CloudWatch   →  Centralised log group
# ─────────────────────────────────────────────────────────────

# ═══════════════════════════════════════════════════════════════
# Data Sources
# ═══════════════════════════════════════════════════════════════

data "aws_availability_zones" "available" {
  state = "available"
}

# ═══════════════════════════════════════════════════════════════
# Random / Secrets
# ═══════════════════════════════════════════════════════════════

resource "random_password" "docdb_master" {
  length  = 32
  special = true
  # Avoid characters that break MongoDB connection strings
  override_special = "!@#$%^&*()-_=+"
}

# ═══════════════════════════════════════════════════════════════
# Locals
# ═══════════════════════════════════════════════════════════════

locals {
  name_prefix = "${var.project_name}-${var.environment}"

  azs = length(var.availability_zones) > 0 ? var.availability_zones : slice(
    data.aws_availability_zones.available.names, 0, 2
  )

  common_tags = merge(
    {
      Project     = var.project_name
      Environment = var.environment
      ManagedBy   = "terraform"
    },
    var.tags,
  )

  # ── Secrets Manager keys ──────────────────────────────────
  secret_docdb_username = "docdb_username"
  secret_docdb_password = "docdb_password"
  secret_docdb_uri      = "docdb_uri"
  secret_katra_api_key  = "katra_api_key"
  secret_mcp_api_key    = "mcp_api_key"
  secret_deepseek_key   = "deepseek_api_key"
  secret_jwt_secret     = "jwt_secret"
  secret_redis_url      = "redis_url"
}

# ═══════════════════════════════════════════════════════════════
# Secrets Manager
# ═══════════════════════════════════════════════════════════════

resource "aws_secretsmanager_secret" "katra" {
  name        = "${local.name_prefix}-secrets"
  description = "Katra secrets — API keys, DB credentials, Redis URL"
  tags        = local.common_tags
}

resource "aws_secretsmanager_secret_version" "katra" {
  secret_id = aws_secretsmanager_secret.katra.id
  secret_string = jsonencode({
    docdb_username  = "admin"
    docdb_password  = random_password.docdb_master.result
    docdb_uri       = "mongodb://admin:${random_password.docdb_master.result}@${aws_docdb_cluster.katra.endpoint}:${aws_docdb_cluster.katra.port}/${var.database_name}?authSource=admin&tls=true"
    katra_api_key   = var.katra_api_key
    mcp_api_key     = coalesce(var.mcp_api_key, var.katra_api_key)
    deepseek_api_key = var.deepseek_api_key
    jwt_secret      = var.jwt_secret
    redis_url       = "redis://${aws_elasticache_replication_group.katra.primary_endpoint_address}:${aws_elasticache_replication_group.katra.port}"
  })

  lifecycle {
    ignore_changes = [secret_string] # allow manual rotation without drift
  }
}

# ═══════════════════════════════════════════════════════════════
# VPC & Networking
# ═══════════════════════════════════════════════════════════════

resource "aws_vpc" "main" {
  cidr_block           = var.vpc_cidr
  enable_dns_hostnames = true
  enable_dns_support   = true

  tags = merge(local.common_tags, {
    Name = "${local.name_prefix}-vpc"
  })
}

# ── Internet Gateway ─────────────────────────────────────────

resource "aws_internet_gateway" "main" {
  vpc_id = aws_vpc.main.id

  tags = merge(local.common_tags, {
    Name = "${local.name_prefix}-igw"
  })
}

# ── Public Subnets (ALB) ─────────────────────────────────────

resource "aws_subnet" "public" {
  count = length(local.azs)

  vpc_id                  = aws_vpc.main.id
  cidr_block              = cidrsubnet(var.vpc_cidr, 8, count.index)
  availability_zone       = local.azs[count.index]
  map_public_ip_on_launch = true

  tags = merge(local.common_tags, {
    Name = "${local.name_prefix}-public-${local.azs[count.index]}"
    Tier = "public"
  })
}

# ── Private Subnets (ECS, DocumentDB, Redis) ─────────────────

resource "aws_subnet" "private" {
  count = length(local.azs)

  vpc_id            = aws_vpc.main.id
  cidr_block        = cidrsubnet(var.vpc_cidr, 8, count.index + length(local.azs))
  availability_zone = local.azs[count.index]

  tags = merge(local.common_tags, {
    Name = "${local.name_prefix}-private-${local.azs[count.index]}"
    Tier = "private"
  })
}

# ── Elastic IPs (NAT Gateways) ───────────────────────────────

resource "aws_eip" "nat" {
  count = var.nat_gateway_count
  domain = "vpc"

  tags = merge(local.common_tags, {
    Name = "${local.name_prefix}-nat-eip-${count.index + 1}"
  })
}

# ── NAT Gateways ─────────────────────────────────────────────

resource "aws_nat_gateway" "main" {
  count = var.nat_gateway_count

  allocation_id = aws_eip.nat[count.index].id
  subnet_id     = aws_subnet.public[count.index].id

  tags = merge(local.common_tags, {
    Name = "${local.name_prefix}-nat-${count.index + 1}"
  })

  depends_on = [aws_internet_gateway.main]
}

# ── Route Tables ─────────────────────────────────────────────

resource "aws_route_table" "public" {
  vpc_id = aws_vpc.main.id

  route {
    cidr_block = "0.0.0.0/0"
    gateway_id = aws_internet_gateway.main.id
  }

  tags = merge(local.common_tags, {
    Name = "${local.name_prefix}-rt-public"
  })
}

resource "aws_route_table" "private" {
  count  = var.nat_gateway_count
  vpc_id = aws_vpc.main.id

  route {
    cidr_block     = "0.0.0.0/0"
    nat_gateway_id = aws_nat_gateway.main[count.index].id
  }

  tags = merge(local.common_tags, {
    Name = "${local.name_prefix}-rt-private-${count.index + 1}"
  })
}

# ── Route Table Associations ─────────────────────────────────

resource "aws_route_table_association" "public" {
  count = length(local.azs)

  subnet_id      = aws_subnet.public[count.index].id
  route_table_id = aws_route_table.public.id
}

resource "aws_route_table_association" "private" {
  count = length(local.azs)

  subnet_id      = aws_subnet.private[count.index].id
  route_table_id = aws_route_table.private[min(count.index, var.nat_gateway_count - 1)].id
}

# ═══════════════════════════════════════════════════════════════
# Security Groups
# ═══════════════════════════════════════════════════════════════

# ── ALB Security Group ───────────────────────────────────────

resource "aws_security_group" "alb" {
  name        = "${local.name_prefix}-alb-sg"
  description = "Katra ALB — ingress HTTP/HTTPS from internet"
  vpc_id      = aws_vpc.main.id

  ingress {
    description      = "HTTP"
    from_port        = 80
    to_port          = 80
    protocol         = "tcp"
    cidr_blocks      = ["0.0.0.0/0"]
    ipv6_cidr_blocks = ["::/0"]
  }

  ingress {
    description      = "HTTPS"
    from_port        = 443
    to_port          = 443
    protocol         = "tcp"
    cidr_blocks      = ["0.0.0.0/0"]
    ipv6_cidr_blocks = ["::/0"]
  }

  egress {
    from_port   = 0
    to_port     = 0
    protocol    = "-1"
    cidr_blocks = ["0.0.0.0/0"]
  }

  tags = merge(local.common_tags, {
    Name = "${local.name_prefix}-alb-sg"
  })
}

# ── ECS Tasks Security Group ─────────────────────────────────

resource "aws_security_group" "ecs" {
  name        = "${local.name_prefix}-ecs-sg"
  description = "Katra ECS tasks"
  vpc_id      = aws_vpc.main.id

  ingress {
    description     = "API port from ALB"
    from_port       = 9002
    to_port         = 9002
    protocol        = "tcp"
    security_groups = [aws_security_group.alb.id]
  }

  ingress {
    description     = "MCP port from ALB"
    from_port       = 3100
    to_port         = 3100
    protocol        = "tcp"
    security_groups = [aws_security_group.alb.id]
  }

  egress {
    from_port   = 0
    to_port     = 0
    protocol    = "-1"
    cidr_blocks = ["0.0.0.0/0"]
  }

  tags = merge(local.common_tags, {
    Name = "${local.name_prefix}-ecs-sg"
  })
}

# ── DocumentDB Security Group ────────────────────────────────

resource "aws_security_group" "docdb" {
  name        = "${local.name_prefix}-docdb-sg"
  description = "Katra DocumentDB"
  vpc_id      = aws_vpc.main.id

  ingress {
    description     = "MongoDB from ECS"
    from_port       = 27017
    to_port         = 27017
    protocol        = "tcp"
    security_groups = [aws_security_group.ecs.id]
  }

  tags = merge(local.common_tags, {
    Name = "${local.name_prefix}-docdb-sg"
  })
}

# ── Redis Security Group ─────────────────────────────────────

resource "aws_security_group" "redis" {
  name        = "${local.name_prefix}-redis-sg"
  description = "Katra Redis"
  vpc_id      = aws_vpc.main.id

  ingress {
    description     = "Redis from ECS"
    from_port       = 6379
    to_port         = 6379
    protocol        = "tcp"
    security_groups = [aws_security_group.ecs.id]
  }

  tags = merge(local.common_tags, {
    Name = "${local.name_prefix}-redis-sg"
  })
}

# VPC endpoint for S3 (ECS tasks access S3 without NAT/IGW)
resource "aws_vpc_endpoint" "s3" {
  vpc_id       = aws_vpc.main.id
  service_name = "com.amazonaws.${var.aws_region}.s3"
  vpc_endpoint_type = "Gateway"
  route_table_ids   = concat(
    [aws_route_table.public.id],
    aws_route_table.private[*].id,
  )

  tags = merge(local.common_tags, {
    Name = "${local.name_prefix}-s3-vpce"
  })
}

# ═══════════════════════════════════════════════════════════════
# S3 — Asset / Object Storage (replaces MinIO)
# ═══════════════════════════════════════════════════════════════

resource "aws_s3_bucket" "assets" {
  bucket        = coalesce(var.s3_bucket_name, "${local.name_prefix}-assets-${data.aws_caller_identity.current.account_id}")
  force_destroy = var.environment != "production"

  tags = merge(local.common_tags, {
    Name = "${local.name_prefix}-assets"
  })
}

resource "aws_s3_bucket_public_access_block" "assets" {
  bucket = aws_s3_bucket.assets.id

  block_public_acls       = true
  block_public_policy     = true
  ignore_public_acls      = true
  restrict_public_buckets = true
}

resource "aws_s3_bucket_server_side_encryption_configuration" "assets" {
  bucket = aws_s3_bucket.assets.id

  rule {
    apply_server_side_encryption_by_default {
      sse_algorithm = "AES256"
    }
  }
}

resource "aws_s3_bucket_versioning" "assets" {
  bucket = aws_s3_bucket.assets.id
  versioning_configuration {
    status = var.environment == "production" ? "Enabled" : "Suspended"
  }
}

# S3 bucket policy — allow only ECS task role
data "aws_iam_policy_document" "s3_bucket_policy" {
  statement {
    effect    = "Allow"
    principals {
      type        = "AWS"
      identifiers = [aws_iam_role.ecs_task.arn]
    }
    actions = [
      "s3:GetObject",
      "s3:PutObject",
      "s3:DeleteObject",
      "s3:ListBucket",
    ]
    resources = [
      aws_s3_bucket.assets.arn,
      "${aws_s3_bucket.assets.arn}/*",
    ]
  }
}

resource "aws_s3_bucket_policy" "assets" {
  bucket = aws_s3_bucket.assets.id
  policy = data.aws_iam_policy_document.s3_bucket_policy.json
}

data "aws_caller_identity" "current" {}

# ═══════════════════════════════════════════════════════════════
# DocumentDB — MongoDB-Compatible (replaces MongoDB)
# ═══════════════════════════════════════════════════════════════

resource "aws_docdb_subnet_group" "katra" {
  name        = "${local.name_prefix}-docdb-subnet"
  description = "Katra DocumentDB subnet group"
  subnet_ids  = aws_subnet.private[*].id

  tags = merge(local.common_tags, {
    Name = "${local.name_prefix}-docdb-subnet"
  })
}

resource "aws_docdb_cluster_parameter_group" "katra" {
  family      = "docdb${split(".", var.docdb_engine_version)[0]}.${split(".", var.docdb_engine_version)[1]}"
  name        = "${local.name_prefix}-docdb-pg"
  description = "Katra DocumentDB cluster parameter group"

  parameter {
    name  = "tls"
    value = "enabled"
  }

  tags = local.common_tags
}

resource "aws_docdb_cluster" "katra" {
  cluster_identifier              = "${local.name_prefix}-docdb"
  engine                          = "docdb"
  engine_version                  = var.docdb_engine_version
  master_username                 = "admin"
  master_password                 = random_password.docdb_master.result
  db_subnet_group_name            = aws_docdb_subnet_group.katra.name
  vpc_security_group_ids          = [aws_security_group.docdb.id]
  db_cluster_parameter_group_name = aws_docdb_cluster_parameter_group.katra.name
  skip_final_snapshot             = var.environment != "production"
  backup_retention_period         = var.environment == "production" ? 14 : 7
  preferred_backup_window         = "03:00-04:00"
  preferred_maintenance_window    = "sun:04:00-sun:05:00"
  storage_encrypted               = true
  deletion_protection             = var.environment == "production"

  tags = merge(local.common_tags, {
    Name = "${local.name_prefix}-docdb"
  })
}

resource "aws_docdb_cluster_instance" "katra" {
  count                = 1
  identifier           = "${local.name_prefix}-docdb-${count.index}"
  cluster_identifier   = aws_docdb_cluster.katra.id
  instance_class       = var.docdb_instance_class
  enable_performance_insights = false

  tags = merge(local.common_tags, {
    Name = "${local.name_prefix}-docdb-instance"
  })
}

# ═══════════════════════════════════════════════════════════════
# ElastiCache Redis (replaces standalone Redis)
# ═══════════════════════════════════════════════════════════════

resource "aws_elasticache_subnet_group" "katra" {
  name        = "${local.name_prefix}-redis-subnet"
  description = "Katra Redis subnet group"
  subnet_ids  = aws_subnet.private[*].id
}

resource "aws_elasticache_parameter_group" "katra" {
  family      = "redis7"
  name        = "${local.name_prefix}-redis-pg"
  description = "Katra Redis parameter group"

  parameter {
    name  = "maxmemory-policy"
    value = "allkeys-lru"
  }

  tags = local.common_tags
}

resource "aws_elasticache_replication_group" "katra" {
  replication_group_id       = "${local.name_prefix}-redis"
  description                = "Katra Redis cache"
  engine                     = "redis"
  engine_version             = var.redis_engine_version
  node_type                  = var.redis_node_type
  num_cache_clusters         = 1
  port                       = 6379
  parameter_group_name       = aws_elasticache_parameter_group.katra.name
  subnet_group_name          = aws_elasticache_subnet_group.katra.name
  security_group_ids         = [aws_security_group.redis.id]
  automatic_failover_enabled = false
  at_rest_encryption_enabled = true
  transit_encryption_enabled = true

  tags = merge(local.common_tags, {
    Name = "${local.name_prefix}-redis"
  })
}

# ═══════════════════════════════════════════════════════════════
# CloudWatch Log Group
# ═══════════════════════════════════════════════════════════════

resource "aws_cloudwatch_log_group" "katra" {
  name              = "/ecs/${local.name_prefix}"
  retention_in_days = var.environment == "production" ? 30 : 7

  tags = merge(local.common_tags, {
    Name = "${local.name_prefix}-logs"
  })
}

# ═══════════════════════════════════════════════════════════════
# IAM Roles & Policies
# ═══════════════════════════════════════════════════════════════

# ── ECS Task Execution Role (pulls image, writes logs) ───────

resource "aws_iam_role" "ecs_task_execution" {
  name = "${local.name_prefix}-ecs-execution-role"

  assume_role_policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect = "Allow"
      Principal = {
        Service = "ecs-tasks.amazonaws.com"
      }
      Action = "sts:AssumeRole"
    }]
  })

  tags = local.common_tags
}

resource "aws_iam_role_policy_attachment" "ecs_task_execution" {
  role       = aws_iam_role.ecs_task_execution.name
  policy_arn = "arn:aws:iam::aws:policy/service-role/AmazonECSTaskExecutionRolePolicy"
}

# Extra: allow pulling from ECR + reading secrets
resource "aws_iam_policy" "ecs_execution_extras" {
  name        = "${local.name_prefix}-ecs-execution-extras"
  description = "Allow ECS task execution to read Secrets Manager secrets"

  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Effect = "Allow"
        Action = [
          "secretsmanager:GetSecretValue",
          "secretsmanager:DescribeSecret",
        ]
        Resource = [aws_secretsmanager_secret.katra.arn]
      },
      {
        Effect = "Allow"
        Action = [
          "kms:Decrypt",
          "kms:GenerateDataKey",
        ]
        Resource = ["*"] # narrowed in production; KMS key for secrets
      },
    ]
  })
}

resource "aws_iam_role_policy_attachment" "ecs_execution_extras" {
  role       = aws_iam_role.ecs_task_execution.name
  policy_arn = aws_iam_policy.ecs_execution_extras.arn
}

# ── ECS Task Role (app-level permissions: S3, etc.) ──────────

resource "aws_iam_role" "ecs_task" {
  name = "${local.name_prefix}-ecs-task-role"

  assume_role_policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect = "Allow"
      Principal = {
        Service = "ecs-tasks.amazonaws.com"
      }
      Action = "sts:AssumeRole"
    }]
  })

  tags = local.common_tags
}

resource "aws_iam_policy" "ecs_task" {
  name        = "${local.name_prefix}-ecs-task-policy"
  description = "Katra ECS task permissions — S3, CloudWatch, STS"

  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Effect = "Allow"
        Action = [
          "s3:GetObject",
          "s3:PutObject",
          "s3:DeleteObject",
          "s3:ListBucket",
        ]
        Resource = [
          aws_s3_bucket.assets.arn,
          "${aws_s3_bucket.assets.arn}/*",
        ]
      },
      {
        Effect = "Allow"
        Action = [
          "logs:CreateLogStream",
          "logs:PutLogEvents",
        ]
        Resource = ["${aws_cloudwatch_log_group.katra.arn}:*"]
      },
      {
        Effect = "Allow"
        Action = [
          "secretsmanager:GetSecretValue",
          "secretsmanager:DescribeSecret",
        ]
        Resource = [aws_secretsmanager_secret.katra.arn]
      },
    ]
  })
}

resource "aws_iam_role_policy_attachment" "ecs_task" {
  role       = aws_iam_role.ecs_task.name
  policy_arn = aws_iam_policy.ecs_task.arn
}

# ═══════════════════════════════════════════════════════════════
# Application Load Balancer
# ═══════════════════════════════════════════════════════════════

resource "aws_lb" "katra" {
  name               = "${replace(local.name_prefix, "_", "-")}-alb"
  internal           = false
  load_balancer_type = "application"
  security_groups    = [aws_security_group.alb.id]
  subnets            = aws_subnet.public[*].id

  enable_deletion_protection       = var.environment == "production"
  enable_cross_zone_load_balancing = true

  tags = merge(local.common_tags, {
    Name = "${local.name_prefix}-alb"
  })
}

# ── Target Groups ────────────────────────────────────────────

# API target group (port 9002)
resource "aws_lb_target_group" "api" {
  name        = "${replace(local.name_prefix, "_", "-")}-api-tg"
  port        = 9002
  protocol    = "HTTP"
  vpc_id      = aws_vpc.main.id
  target_type = "ip"

  health_check {
    path                = "/api/v1/health"
    protocol            = "HTTP"
    matcher             = "200"
    interval            = 30
    timeout             = 5
    healthy_threshold   = 3
    unhealthy_threshold = 3
  }

  deregistration_delay = 30

  tags = merge(local.common_tags, {
    Name = "${local.name_prefix}-api-tg"
  })
}

# MCP target group (port 3100)
resource "aws_lb_target_group" "mcp" {
  name        = "${replace(local.name_prefix, "_", "-")}-mcp-tg"
  port        = 3100
  protocol    = "HTTP"
  vpc_id      = aws_vpc.main.id
  target_type = "ip"

  health_check {
    path                = "/health"
    protocol            = "HTTP"
    matcher             = "200"
    interval            = 30
    timeout             = 5
    healthy_threshold   = 3
    unhealthy_threshold = 3
  }

  deregistration_delay = 30

  tags = merge(local.common_tags, {
    Name = "${local.name_prefix}-mcp-tg"
  })
}

# ── HTTP Listener (port 80) ──────────────────────────────────

resource "aws_lb_listener" "http" {
  load_balancer_arn = aws_lb.katra.arn
  port              = 80
  protocol          = "HTTP"

  default_action {
    type = "redirect"
    redirect {
      port        = "443"
      protocol    = "HTTPS"
      status_code = "HTTP_301"
    }
  }
}

# ── HTTPS Listener (port 443) ────────────────────────────────

resource "aws_lb_listener" "https" {
  load_balancer_arn = aws_lb.katra.arn
  port              = 443
  protocol          = "HTTPS"
  ssl_policy        = "ELBSecurityPolicy-TLS13-1-2-Res-2021-06"
  certificate_arn   = var.acm_certificate_arn

  default_action {
    type = "fixed-response"
    fixed_response {
      content_type = "text/plain"
      message_body = "OK — Katra is running"
      status_code  = "200"
    }
  }
}

# ── Listener Rules (path-based routing) ──────────────────────

resource "aws_lb_listener_rule" "api" {
  listener_arn = aws_lb_listener.https.arn
  priority     = 10

  condition {
    path_pattern {
      values = ["/api", "/api/*"]
    }
  }

  action {
    type             = "forward"
    target_group_arn = aws_lb_target_group.api.arn
  }
}

resource "aws_lb_listener_rule" "mcp" {
  listener_arn = aws_lb_listener.https.arn
  priority     = 20

  condition {
    path_pattern {
      values = ["/mcp", "/mcp/*"]
    }
  }

  action {
    type             = "forward"
    target_group_arn = aws_lb_target_group.mcp.arn
  }
}

# ═══════════════════════════════════════════════════════════════
# ECS Fargate — Cluster, Task Definition, Service
# ═══════════════════════════════════════════════════════════════

resource "aws_ecs_cluster" "katra" {
  name = "${local.name_prefix}-cluster"

  setting {
    name  = "containerInsights"
    value = "enabled"
  }

  tags = merge(local.common_tags, {
    Name = "${local.name_prefix}-cluster"
  })
}

# ── Task Definition ──────────────────────────────────────────

resource "aws_ecs_task_definition" "katra" {
  family                   = local.name_prefix
  requires_compatibilities = ["FARGATE"]
  network_mode             = "awsvpc"
  cpu                      = var.task_cpu
  memory                   = var.task_memory
  execution_role_arn       = aws_iam_role.ecs_task_execution.arn
  task_role_arn            = aws_iam_role.ecs_task.arn

  container_definitions = jsonencode([
    {
      name      = "katra"
      image     = var.katra_image
      essential = true

      portMappings = [
        {
          containerPort = 9002
          protocol      = "tcp"
          appProtocol   = "http"
          name          = "api"
        },
        {
          containerPort = 3100
          protocol      = "tcp"
          appProtocol   = "http"
          name          = "mcp"
        }
      ]

      # Merge LLM_MODEL only if specified
      environment = concat([
        { name = "DATABASE_NAME", value = var.database_name },
        { name = "LLM_PROVIDER", value = var.llm_provider },
        { name = "EMBEDDING_PROVIDER", value = var.embedding_provider },
        { name = "S3_ENDPOINT", value = "https://s3.${var.aws_region}.amazonaws.com" },
        { name = "S3_REGION", value = var.aws_region },
        { name = "S3_BUCKET_NAME", value = aws_s3_bucket.assets.id },
        { name = "PORT", value = "9002" },
        { name = "MCP_PORT", value = "3100" },
        { name = "HOST", value = "0.0.0.0" },
        { name = "MULTI_TENANT", value = tostring(var.multi_tenant) },
        { name = "TENANT_ISOLATION", value = var.tenant_isolation },
      ], var.llm_model != "" ? [{ name = "LLM_MODEL", value = var.llm_model }] : [])

      secrets = compact([
        { name = "MONGODB_URI", valueFrom = "${aws_secretsmanager_secret.katra.arn}:docdb_uri::" },
        { name = "REDIS_URL", valueFrom = "${aws_secretsmanager_secret.katra.arn}:redis_url::" },
        { name = "KATRA_API_KEY", valueFrom = "${aws_secretsmanager_secret.katra.arn}:katra_api_key::" },
        var.mcp_api_key != null ? { name = "MCP_API_KEY", valueFrom = "${aws_secretsmanager_secret.katra.arn}:mcp_api_key::" } : null,
        var.deepseek_api_key != null ? { name = "LLM_API_KEY", valueFrom = "${aws_secretsmanager_secret.katra.arn}:deepseek_api_key::" } : null,
        var.jwt_secret != null ? { name = "JWT_SECRET", valueFrom = "${aws_secretsmanager_secret.katra.arn}:jwt_secret::" } : null,
      ])

      logConfiguration = {
        logDriver = "awslogs"
        options = {
          "awslogs-group"         = aws_cloudwatch_log_group.katra.name
          "awslogs-region"        = var.aws_region
          "awslogs-stream-prefix" = "katra"
        }
      }

      healthCheck = {
        command     = ["CMD-SHELL", "curl -f http://localhost:9002/api/v1/health || exit 1"]
        interval    = 30
        timeout     = 5
        retries     = 3
        startPeriod = 60
      }
    }
  ])

  tags = merge(local.common_tags, {
    Name = "${local.name_prefix}-taskdef"
  })
}

# ── ECS Service ──────────────────────────────────────────────

resource "aws_ecs_service" "katra" {
  name            = "${local.name_prefix}-svc"
  cluster         = aws_ecs_cluster.katra.id
  task_definition = aws_ecs_task_definition.katra.arn
  desired_count   = var.desired_count
  launch_type     = "FARGATE"

  network_configuration {
    subnets          = aws_subnet.private[*].id
    security_groups  = [aws_security_group.ecs.id]
    assign_public_ip = false
  }

  load_balancer {
    target_group_arn = aws_lb_target_group.api.arn
    container_name   = "katra"
    container_port   = 9002
  }

  load_balancer {
    target_group_arn = aws_lb_target_group.mcp.arn
    container_name   = "katra"
    container_port   = 3100
  }

  enable_execute_command = true
  deployment_minimum_healthy_percent = 100
  deployment_maximum_percent         = 200

  depends_on = [
    aws_lb_listener.http,
    aws_docdb_cluster_instance.katra,
    aws_elasticache_replication_group.katra,
  ]

  tags = merge(local.common_tags, {
    Name = "${local.name_prefix}-svc"
  })
}
