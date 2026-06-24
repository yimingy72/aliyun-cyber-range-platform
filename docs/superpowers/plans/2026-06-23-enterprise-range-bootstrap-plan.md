# 企业网络型靶场 Bootstrap Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 把当前仓库的 IaC 主线从 `single-ecs` 验证模块切换到第一版企业网络型靶场骨架，为后续模板蓝图升级和编排收口建立正确入口。

**Architecture:** 保留现有 monorepo 与 OpenTofu Runner 结构不变，新建 `infra/opentofu/modules/alicloud-enterprise-range` 与对应 example root module，让静态验证、示例验证和后续 Runner 接口都围绕 `single-vpc + multi-vswitch + multi-ecs + dmz-eip` 骨架组织。旧的 `alicloud-vpc-single-ecs` 模块保留为历史通路验证，不再作为当前默认目标。

**Tech Stack:** OpenTofu、Alibaba Cloud Provider、Node.js test runner、pnpm workspace、shell 验证脚本

---

## 范围检查

本计划只覆盖当前最紧急的一个子项目：

- OpenTofu 静态测试纠偏
- 企业网络型阿里云模块骨架
- 示例 root module 与静态验证入口

本计划明确不包含：

- `RangeTemplate` 数据模型升级
- `RangeInstance.accessEntry` 回写升级
- Worker / Runner / StepLog 编排收口
- 真实云侧 `apply/destroy`

## 文件结构

### 现有文件修改

- 修改：`test/opentofu-bootstrap.test.mjs`
  职责：把静态断言从 `single-ecs` 切到企业网络型骨架
- 修改：`package.json`
  职责：把 `iac:validate` 指向新的 example 验证入口
- 修改：`scripts/dev/validate-opentofu-example.sh`
  职责：默认验证新的 example 路径
- 修改：`.env.example`
  职责：补充企业网络型 example 所需变量说明

### 新增文件

- 新建：`infra/opentofu/modules/alicloud-enterprise-range/providers.tf`
- 新建：`infra/opentofu/modules/alicloud-enterprise-range/variables.tf`
- 新建：`infra/opentofu/modules/alicloud-enterprise-range/main.tf`
- 新建：`infra/opentofu/modules/alicloud-enterprise-range/outputs.tf`
- 新建：`infra/opentofu/modules/alicloud-enterprise-range/README.md`
- 新建：`infra/opentofu/examples/alicloud-enterprise-range/versions.tf`
- 新建：`infra/opentofu/examples/alicloud-enterprise-range/main.tf`
- 新建：`infra/opentofu/examples/alicloud-enterprise-range/variables.tf`
- 新建：`infra/opentofu/examples/alicloud-enterprise-range/outputs.tf`
- 新建：`infra/opentofu/examples/alicloud-enterprise-range/range.auto.tfvars.example`

## 任务 1：把静态测试改成企业网络型骨架断言

**Files:**
- Modify: `test/opentofu-bootstrap.test.mjs`

- [ ] **Step 1: 先写失败测试**

把模块与 example 的断言从 `alicloud-vpc-single-ecs` 切换为 `alicloud-enterprise-range`，最少新增这些断言：

```js
const mainTf = fs.readFileSync(
  new URL('../infra/opentofu/modules/alicloud-enterprise-range/main.tf', import.meta.url),
  'utf8',
);
const outputsTf = fs.readFileSync(
  new URL('../infra/opentofu/modules/alicloud-enterprise-range/outputs.tf', import.meta.url),
  'utf8',
);

assert.match(mainTf, /resource "alicloud_vpc"/);
assert.match(mainTf, /resource "alicloud_vswitch" "dmz"/);
assert.match(mainTf, /resource "alicloud_vswitch" "office"/);
assert.match(mainTf, /resource "alicloud_vswitch" "server"/);
assert.match(mainTf, /resource "alicloud_instance" "dmz"/);
assert.match(mainTf, /resource "alicloud_instance" "office"/);
assert.match(mainTf, /resource "alicloud_instance" "server"/);
assert.match(mainTf, /resource "alicloud_eip_address" "dmz"/);
assert.match(mainTf, /resource "alicloud_eip_association" "dmz"/);
assert.match(outputsTf, /output "public_entry"/);
assert.match(outputsTf, /output "resource_summary"/);
```

- [ ] **Step 2: 运行测试并确认失败**

Run: `node --test test/opentofu-bootstrap.test.mjs`

Expected: FAIL，因为新模块和新 example 还不存在。

- [ ] **Step 3: 同步把 example 路径断言改到新目录**

把旧断言：

```js
assert.match(exampleMainTf, /source\\s*=\\s*"\\.\\.\\/\\.\\.\\/modules\\/alicloud-vpc-single-ecs"/);
```

替换为：

```js
assert.match(exampleMainTf, /source\\s*=\\s*"\\.\\.\\/\\.\\.\\/modules\\/alicloud-enterprise-range"/);
```

- [ ] **Step 4: 再次运行测试，确认失败点仍停留在文件缺失**

Run: `node --test test/opentofu-bootstrap.test.mjs`

Expected: FAIL，且失败原因是目标文件尚未创建，而不是测试本身写错。

- [ ] **Step 5: Commit**

```bash
git add test/opentofu-bootstrap.test.mjs
git commit -m "test: realign opentofu bootstrap expectations"
```

## 任务 2：建立企业网络型 OpenTofu 模块骨架

**Files:**
- Create: `infra/opentofu/modules/alicloud-enterprise-range/providers.tf`
- Create: `infra/opentofu/modules/alicloud-enterprise-range/variables.tf`
- Create: `infra/opentofu/modules/alicloud-enterprise-range/main.tf`
- Create: `infra/opentofu/modules/alicloud-enterprise-range/outputs.tf`
- Create: `infra/opentofu/modules/alicloud-enterprise-range/README.md`

- [ ] **Step 1: 先写最小变量定义**

`infra/opentofu/modules/alicloud-enterprise-range/variables.tf`

```tf
variable "resource_name_prefix" {
  type        = string
  description = "Short prefix used across the enterprise cyber range resources."
}

variable "zone_id" {
  type        = string
  description = "Alibaba Cloud zone used by the vSwitches and ECS instances."
}

variable "vpc_cidr" {
  type        = string
  description = "CIDR block used by the per-team VPC."
}

variable "dmz_cidr" {
  type        = string
  description = "CIDR block used by the DMZ subnet."
}

variable "office_cidr" {
  type        = string
  description = "CIDR block used by the office subnet."
}

variable "server_cidr" {
  type        = string
  description = "CIDR block used by the server subnet."
}

variable "dmz_private_ip" {
  type        = string
  description = "Fixed private IP for the DMZ entry ECS instance."
}

variable "office_private_ip" {
  type        = string
  description = "Fixed private IP for the office ECS instance."
}

variable "server_private_ip" {
  type        = string
  description = "Fixed private IP for the server ECS instance."
}

variable "instance_type" {
  type        = string
  description = "Alibaba Cloud ECS instance type used by all stage-one hosts."
}

variable "image_id" {
  type        = string
  description = "Alibaba Cloud image ID used by all stage-one hosts."
}

variable "instance_password" {
  type        = string
  description = "Administrator password used by all stage-one hosts."
  sensitive   = true
}

variable "allowed_ingress_cidr" {
  type        = string
  description = "Ingress CIDR allowed to reach the DMZ entry host."
  default     = "0.0.0.0/0"
}

variable "tags" {
  type        = map(string)
  description = "Optional tags applied to supported resources."
  default     = {}
}
```

- [ ] **Step 2: 写最小主模块骨架**

`infra/opentofu/modules/alicloud-enterprise-range/main.tf`

```tf
locals {
  common_tags = merge(
    {
      managed_by = "aliyun-cyber-range-platform"
      module     = "alicloud-enterprise-range"
    },
    var.tags,
  )
}

resource "alicloud_vpc" "range" {
  vpc_name   = "${var.resource_name_prefix}-vpc"
  cidr_block = var.vpc_cidr
  tags       = local.common_tags
}

resource "alicloud_vswitch" "dmz" {
  vpc_id       = alicloud_vpc.range.id
  zone_id      = var.zone_id
  cidr_block   = var.dmz_cidr
  vswitch_name = "${var.resource_name_prefix}-dmz"
  tags         = local.common_tags
}

resource "alicloud_vswitch" "office" {
  vpc_id       = alicloud_vpc.range.id
  zone_id      = var.zone_id
  cidr_block   = var.office_cidr
  vswitch_name = "${var.resource_name_prefix}-office"
  tags         = local.common_tags
}

resource "alicloud_vswitch" "server" {
  vpc_id       = alicloud_vpc.range.id
  zone_id      = var.zone_id
  cidr_block   = var.server_cidr
  vswitch_name = "${var.resource_name_prefix}-server"
  tags         = local.common_tags
}

resource "alicloud_security_group" "range" {
  security_group_name = "${var.resource_name_prefix}-sg"
  description         = "Security group for the stage-one enterprise cyber range."
  vpc_id              = alicloud_vpc.range.id
  tags                = local.common_tags
}

resource "alicloud_security_group_rule" "dmz_ssh_ingress" {
  type              = "ingress"
  ip_protocol       = "tcp"
  nic_type          = "intranet"
  policy            = "accept"
  port_range        = "22/22"
  priority          = 1
  security_group_id = alicloud_security_group.range.id
  cidr_ip           = var.allowed_ingress_cidr
}

resource "alicloud_security_group_rule" "dmz_web_ingress" {
  type              = "ingress"
  ip_protocol       = "tcp"
  nic_type          = "intranet"
  policy            = "accept"
  port_range        = "80/80"
  priority          = 1
  security_group_id = alicloud_security_group.range.id
  cidr_ip           = var.allowed_ingress_cidr
}

resource "alicloud_instance" "dmz" {
  instance_name   = "${var.resource_name_prefix}-dmz"
  host_name       = "${var.resource_name_prefix}-dmz"
  instance_type   = var.instance_type
  image_id        = var.image_id
  password        = var.instance_password
  security_groups = [alicloud_security_group.range.id]
  vswitch_id      = alicloud_vswitch.dmz.id
  private_ip      = var.dmz_private_ip
  tags            = merge(local.common_tags, { role = "dmz" })
}

resource "alicloud_instance" "office" {
  instance_name   = "${var.resource_name_prefix}-office"
  host_name       = "${var.resource_name_prefix}-office"
  instance_type   = var.instance_type
  image_id        = var.image_id
  password        = var.instance_password
  security_groups = [alicloud_security_group.range.id]
  vswitch_id      = alicloud_vswitch.office.id
  private_ip      = var.office_private_ip
  tags            = merge(local.common_tags, { role = "office" })
}

resource "alicloud_instance" "server" {
  instance_name   = "${var.resource_name_prefix}-server"
  host_name       = "${var.resource_name_prefix}-server"
  instance_type   = var.instance_type
  image_id        = var.image_id
  password        = var.instance_password
  security_groups = [alicloud_security_group.range.id]
  vswitch_id      = alicloud_vswitch.server.id
  private_ip      = var.server_private_ip
  tags            = merge(local.common_tags, { role = "server" })
}

resource "alicloud_eip_address" "dmz" {
  address_name         = "${var.resource_name_prefix}-dmz-eip"
  internet_charge_type = "PayByTraffic"
  payment_type         = "PayAsYouGo"
  bandwidth            = "10"
  tags                 = merge(local.common_tags, { role = "entry" })
}

resource "alicloud_eip_association" "dmz" {
  allocation_id = alicloud_eip_address.dmz.id
  instance_id   = alicloud_instance.dmz.id
}
```

- [ ] **Step 3: 写输出契约**

`infra/opentofu/modules/alicloud-enterprise-range/outputs.tf`

```tf
output "vpc_id" {
  value = alicloud_vpc.range.id
}

output "subnet_ids" {
  value = {
    dmz    = alicloud_vswitch.dmz.id
    office = alicloud_vswitch.office.id
    server = alicloud_vswitch.server.id
  }
}

output "host_ids" {
  value = {
    dmz    = alicloud_instance.dmz.id
    office = alicloud_instance.office.id
    server = alicloud_instance.server.id
  }
}

output "public_entry" {
  value = {
    host_role = "dmz"
    public_ip = alicloud_eip_address.dmz.ip_address
    private_ip = alicloud_instance.dmz.private_ip
    ssh = "ssh root@${alicloud_eip_address.dmz.ip_address}"
  }
}

output "resource_summary" {
  value = {
    vpc_id = alicloud_vpc.range.id
    subnet_ids = {
      dmz    = alicloud_vswitch.dmz.id
      office = alicloud_vswitch.office.id
      server = alicloud_vswitch.server.id
    }
    eip_allocation_id = alicloud_eip_address.dmz.id
    host_ids = {
      dmz    = alicloud_instance.dmz.id
      office = alicloud_instance.office.id
      server = alicloud_instance.server.id
    }
  }
}
```

- [ ] **Step 4: 写 README，明确这是第一版企业网络型骨架**

README 至少写清楚：

- 这不是最终完整靶场模板
- 当前目标是 `single-vpc + multi-vswitch + multi-ecs + dmz-eip`
- 固定私网 IP 由调用方显式传入
- 后续再扩到更多网络区和更多资源类型

- [ ] **Step 5: 运行测试，确认新模块满足静态断言**

Run: `node --test test/opentofu-bootstrap.test.mjs`

Expected: 与模块相关的断言通过，但 example/脚本相关断言仍可能失败。

## 任务 3：建立新的 example root module 与验证入口

**Files:**
- Create: `infra/opentofu/examples/alicloud-enterprise-range/versions.tf`
- Create: `infra/opentofu/examples/alicloud-enterprise-range/main.tf`
- Create: `infra/opentofu/examples/alicloud-enterprise-range/variables.tf`
- Create: `infra/opentofu/examples/alicloud-enterprise-range/outputs.tf`
- Create: `infra/opentofu/examples/alicloud-enterprise-range/range.auto.tfvars.example`
- Modify: `scripts/dev/validate-opentofu-example.sh`
- Modify: `package.json`
- Modify: `.env.example`

- [ ] **Step 1: 写 example root module**

`infra/opentofu/examples/alicloud-enterprise-range/main.tf`

```tf
provider "alicloud" {
  access_key = var.access_key
  secret_key = var.secret_key
  region     = var.region
}

module "range" {
  source = "../../modules/alicloud-enterprise-range"

  resource_name_prefix = var.resource_name_prefix
  zone_id              = var.zone_id
  vpc_cidr             = var.vpc_cidr
  dmz_cidr             = var.dmz_cidr
  office_cidr          = var.office_cidr
  server_cidr          = var.server_cidr
  dmz_private_ip       = var.dmz_private_ip
  office_private_ip    = var.office_private_ip
  server_private_ip    = var.server_private_ip
  instance_type        = var.instance_type
  image_id             = var.image_id
  instance_password    = var.instance_password
}
```

- [ ] **Step 2: 写变量与示例参数**

`infra/opentofu/examples/alicloud-enterprise-range/variables.tf`

```tf
variable "access_key" {
  type      = string
  sensitive = true
}

variable "secret_key" {
  type      = string
  sensitive = true
}

variable "region" {
  type = string
}

variable "zone_id" {
  type = string
}

variable "resource_name_prefix" {
  type = string
}

variable "vpc_cidr" {
  type = string
}

variable "dmz_cidr" {
  type = string
}

variable "office_cidr" {
  type = string
}

variable "server_cidr" {
  type = string
}

variable "dmz_private_ip" {
  type = string
}

variable "office_private_ip" {
  type = string
}

variable "server_private_ip" {
  type = string
}

variable "instance_type" {
  type = string
}

variable "image_id" {
  type = string
}

variable "instance_password" {
  type      = string
  sensitive = true
}
```

`infra/opentofu/examples/alicloud-enterprise-range/range.auto.tfvars.example`

```tf
resource_name_prefix = "team-blue"
vpc_cidr             = "10.70.0.0/16"
dmz_cidr             = "10.70.10.0/24"
office_cidr          = "10.70.20.0/24"
server_cidr          = "10.70.30.0/24"
dmz_private_ip       = "10.70.10.10"
office_private_ip    = "10.70.20.10"
server_private_ip    = "10.70.30.10"
instance_type        = "ecs.c7.large"
image_id             = "replace-me"
instance_password    = "ReplaceWithStrongPassword123!"
```

- [ ] **Step 3: 调整验证脚本和根脚本**

把 `scripts/dev/validate-opentofu-example.sh` 中的 example 默认目录切到：

```bash
EXAMPLE_DIR="${ROOT_DIR}/infra/opentofu/examples/alicloud-enterprise-range"
```

把 `package.json` 中的脚本保持为：

```json
"iac:validate": "scripts/dev/validate-opentofu-example.sh"
```

但要求脚本实际验证新的 example 路径。

- [ ] **Step 4: 更新 `.env.example`**

至少补充：

```dotenv
ALICLOUD_REGION=
ALICLOUD_ZONE_ID=
ALICLOUD_IMAGE_ID=
ALICLOUD_INSTANCE_TYPE=auto
ALICLOUD_INSTANCE_TYPE_PREFERENCES=
ALICLOUD_RANGE_VPC_CIDR=10.70.0.0/16
ALICLOUD_RANGE_DMZ_CIDR=10.70.10.0/24
ALICLOUD_RANGE_OFFICE_CIDR=10.70.20.0/24
ALICLOUD_RANGE_SERVER_CIDR=10.70.30.0/24
ALICLOUD_RANGE_DMZ_PRIVATE_IP=10.70.10.10
ALICLOUD_RANGE_OFFICE_PRIVATE_IP=10.70.20.10
ALICLOUD_RANGE_SERVER_PRIVATE_IP=10.70.30.10
```

说明：

- `.env.example` 的默认行为应由上层脚本/Provisioner 解析 `auto`
- 底层 OpenTofu module/example 仍接收具体 `instance_type`，不直接在 IaC 里实现自动选型

- [ ] **Step 5: 运行静态验证**

Run:

```bash
node --test test/opentofu-bootstrap.test.mjs
TOFU_IMAGE=vdagxumcha4qdz-ghcr.xuanyuan.run/opentofu/opentofu:1.12.3-minimal \
ALICLOUD_PROVIDER_ZIP_PATH=/Users/yym/Downloads/terraform-provider-alicloud_1.282.0_linux_amd64.zip \
HTTPS_PROXY=http://127.0.0.1:7897 \
HTTP_PROXY=http://127.0.0.1:7897 \
ALL_PROXY=socks5://127.0.0.1:7897 \
https_proxy=http://127.0.0.1:7897 \
http_proxy=http://127.0.0.1:7897 \
all_proxy=socks5://127.0.0.1:7897 \
pnpm iac:validate
```

Expected: PASS。

## 任务 4：整理收尾并记录下一子计划入口

**Files:**
- Modify: `docs/superpowers/plans/2026-06-23-cloud-cyber-range-saas-implementation-plan.md`

- [ ] **Step 1: 在总计划中标记本子计划完成条件**

写清楚：

- 企业网络型模块已成为当前主验证入口
- `single-ecs` 模块仅作为历史验证样例保留

- [ ] **Step 2: 记录下一子计划的进入条件**

下一份子计划的进入条件是：

- OpenTofu 企业网络型 bootstrap 已静态通过
- 可以开始升级 `RangeTemplate` 蓝图结构和 `RangeInstance` 输出契约

- [ ] **Step 3: 运行最终验证**

Run:

```bash
node --test test/opentofu-bootstrap.test.mjs
pnpm iac:validate
```

Expected: PASS。

- [ ] **Step 4: Commit**

```bash
git add test/opentofu-bootstrap.test.mjs package.json .env.example scripts/dev/validate-opentofu-example.sh infra/opentofu docs/superpowers/plans/2026-06-23-cloud-cyber-range-saas-implementation-plan.md
git commit -m "feat: bootstrap enterprise cyber range module"
```

- [ ] **Step 5: 记录后续计划入口**

下一份计划建议文件名：

```text
docs/superpowers/plans/2026-06-23-template-blueprint-upgrade-plan.md
```
