# Keycloak 单客户端与 MCP OAuth 迁移

新链路通过 `PLATFORM_AUTH_MODE=keycloak` 启用。默认仍走现网旧链路；本说明不是公网切换授权。不要覆盖已有领域、不要在并行验证前停用旧客户端，也不要将测试账号导入生产。

## Keycloak 26.8.2

部署清单和独立身份回归固定使用 `quay.io/keycloak/keycloak:26.8.2`。26.8.2 的 Admin REST API 同时检查管理接口 audience 和 `kc-admin-api` scope。对已经存在的统一客户端，在「客户端 → cyber-range → 客户端范围」关联内置 `kc-admin-api`，类型选「可选」。身份查询服务的 client credentials 请求显式申请该 scope，网页仍申请 `openid web-access`，MCP 上游仍申请 `openid mcp-access`。不要将它设为默认范围，也不要关闭新版的 audience 检查。服务账号保留 `view-users`、`query-users`，增加只读 `view-clients` 以读取新版会按角色可见性筛选的客户端角色映射；不分配 `manage-users`、`manage-clients` 或 `realm-admin`。

26.6.2 起令牌 introspection 要求调用方在令牌 audience 中。统一客户端通过 `cyber-range-introspection-audience` mapper 加入 `cyber-range` audience；网页和 MCP 仍分别要求 `cyber-range-web` 和 `cyber-range-mcp`，不能互用令牌。已有客户端也须增加该 mapper；不启用跳过 audience 校验的兼容选项。旧令牌需刷新或重新登录才能得到新的 audience。

跨小版本升级必须先在隔离数据库副本上演练迁移，再停止旧 Keycloak，备份 PostgreSQL、容器配置、主题与角色/群组映射，然后启动新版。已有领域不重新导入。验证管理后台、平台 Web 登录、MCP 授权与刷新、普通用户空间隔离和管理员权限后再完成切换。回退必须同时恢复旧镜像与停止时的数据库备份，不能让旧镜像连接已迁移的数据库。数据库副本含敏感身份数据，备份和临时环境必须限制访问，验证后删除副本容器与卷。

基础清单对旧认证链路仍显式保留 `token-exchange:v1,admin-fine-grained-authz:v1`，避免不带版本的 feature 名称切换到不兼容的 FGAP v2；统一认证不依赖旧令牌交换。此次升级不启用 `cimd` 或 `resource-indicators` 实验功能，MCP 继续使用平台已有的 OAuth broker。

## 认证和授权

- 新建部署的 [领域配置](../../infra/keycloak-unified/realm-cyber-range.json) 只含一个靶场客户端 `cyber-range`。Keycloak 自带客户端保留。Web 在服务端交换带 PKCE 的授权码；MCP 由靶场网关接受公开客户端注册、处理浏览器同意，再向同一 Keycloak 客户端交换授权码。Codex 的客户端注册存在靶场数据库，不占用 Keycloak 客户端。密钥不放入网页构建变量、MCP 客户端配置或浏览器。
- Keycloak 通过可选范围 `web-access`、`mcp-access` 分别签发受众为 `cyber-range-web`、`cyber-range-mcp` 的令牌。MCP Agent 拿到的仅是网关凭据；其上游令牌加密保存在数据库。网关核验受众、签名及活动会话后给 API 发短时内部凭据，原始 Keycloak 令牌和 Agent 凭据都不转发。API 在每次请求时重新确认 Keycloak 账号、角色和工作空间，再按[产品权限清单](../product/platform-permissions.md)执行业务检查。
- 日常维护在 Keycloak 的 `cyber-range` 领域完成：创建账号并设置初始密码，分配同名客户端的 `user` 或 `admin` 角色。普通用户再加入一个已映射的工作空间群组；管理员可选择全部工作空间，不依赖群组分配。应用配置 `OIDC_WORKSPACE_GROUP_MAP` 将**群组 UUID** 映射到业务工作空间 ID；组名不是授权凭据。未加入有效群组或同时命中多个工作空间时拒绝。已有业务用户必须匹配其原空间；确需换绑的历史账号，先制定显式的数据归属迁移，不通过换组迁移历史。
- `cyber-range` 客户端只定义 `user` 和 `admin`。客户端 `admin` 直接拥有平台级管理能力，包括跨空间选择、账号绑定与资源告警；不再需要 `platform-operator` 或存量超管标记。普通用户仍须且只能匹配一个工作空间群组。提升或降级现有用户不重写其内部 ID、原工作空间和资源归属；有效权限每次从 Keycloak 获取。后台巡检也实时核验指定管理员，撤权后不再按旧标记继续扫描；已受理的异步作业不因撤权被重放或自动取消。
- 靶场数据库保留业务用户及其内部 ID，用经过验证的 `(issuer, subject)` 绑定身份。新用户首次获准进入时创建业务记录，不设本地密码，也不按显示名匹配旧账号。Keycloak 只读服务账号只查用户、角色和组，不再负责创建、密码重置或同步状态。统一模式不注册旧用户管理接口和同步服务，Web 隐藏并拒绝旧页面，MCP 不公开用户管理工具。账单仍用管理员可见的本工作空间只读成员清单。

## 并行验证、切换与回滚

### 更新公网登录和 MCP 授权主题

从同一发布提交构建 Keycloak 和 MCP 镜像。Keycloak 只在现有版本的基础镜像上加入主题文件，不执行领域导入或变更认证配置：

```sh
docker build -t "cyber-range-release-keycloak:$release" infra/keycloak
docker build -t "cyber-range-release-mcp:$release" -f apps/mcp/Dockerfile .
```

公网已有领域的发布清单要同时固定新 MCP 镜像与 `KEYCLOAK_THEME_IMAGE=cyber-range-release-keycloak:<提交>`，并在原 Keycloak 升级覆盖之后应用 [主题发布覆盖文件](../../deploy/current-system/docker-compose.keycloak-theme-release.yml)。保留该覆盖文件在后续发布清单中：它移除旧的主题和导入挂载，保证重建时使用镜像内的文件。更新前核对合并配置中 Keycloak 的启动命令没有 `--import-realm`、没有挂载覆盖 `/opt/keycloak/themes`，并继续使用原数据库。保留上一版发布清单与镜像以便回滚。

只重建 Keycloak 和 MCP 服务。检查实际 Keycloak 容器中的模板、脚本和样式与发布提交一致；新进程会重新生成模板缓存。用新浏览器会话走首页和 MCP 登录，检查 HTML 引用的版本化 CSS、脚本、授权卡片和回跳页都能加载，再验证 Web 登录及 MCP 授权。反向代理、证书、issuer、回调和管理入口访问规则沿用当前配置。

### 统一认证切换

1. **保全现网。** 备份 Keycloak 数据库和靶场数据库，保留当前镜像、Compose 配置、旧客户端及密钥。公网此前只改过 `platform-web`、`platform-admin`、`mcp-gateway`、`smoke-conf`、`mcp-smoke-sa` 的显示名称和说明，`platform-api` 保留原名；这些名称不参与迁移。两个测试客户端只应保留在需要旧链路回归的测试环境。
2. **增加新客户端与映射。** 在同一领域**新增** `cyber-range`，保留同一 issuer 和现有用户的 subject。用领域 JSON 中的客户端角色、可选范围和只读服务账号作模板；不要对已有领域执行覆盖导入。逐项核对现有业务用户绑定、启停、角色和归属，尤其是禁用账号与超管，不能通过用户名重建映射。无法核验的历史记录保留原归属且不得获得访问。
3. **并行试运行。** 给 Web 和 MCP 使用独立测试入口，用各自准确的 HTTPS 回调、受众和预览 API。先应用可兼容旧镜像的新增表迁移。由服务端管理 `OIDC_UNIFIED_CLIENT_SECRET`、`OIDC_MCP_DELEGATION_KEY`（独立随机密钥）和 `OIDC_MCP_BROKER_KEY`（独立 32 字节 hex 密钥）；固定 `OIDC_UNIFIED_CLIENT_UUID` 到实际注册 ID。Caddy 把 `/mcp/oauth/*` 和 `/.well-known/oauth-authorization-server` 交给网关，把 `/auth/oidc/token` 交给 Web，原管理端访问限制不变。内部 API 走 Compose 网络，不能把内部凭据记录到日志。公网开放注册前为注册和授权端点设置入口速率限制，监控登录错误率和 OAuth 记录容量。
4. **验证后再切换。** 同一套 Keycloak 角色和工作空间断言必须通过 Web、MCP 和后台巡检；用下方测试确认新旧归属、权限、停用及普通用户访问。核验普通用户和管理员的真实代表账号后，才切换入口。已保存旧令牌的 Agent 需在切换后重新授权：`codex mcp logout <名称>`、`codex mcp login <名称>`。新 Codex 只需 MCP 地址。已验证 Codex 的 DCR，其他只支持 CIMD 或不支持发现／动态注册的 Agent 需单独验证；不共享靶场密钥。受控远端回调可列入 `OIDC_MCP_ALLOWED_REDIRECTS`；无允许项时只接受带端口的本机回调。静态外部注册如有保留，必须明确纳入 `OIDC_MCP_EXTERNAL_CLIENTS` 并验证其专用受众，不作为新 Codex 登录的前置条件。
5. **可逆观察。** 观察期保留旧镜像、客户端及旧字段。若失败，恢复旧 Web、API、MCP 和代理入口组合；不回滚用户或资源 ID，不删除新增 OAuth 表。窗口内新增业务用户和 Keycloak 角色变更需记录，并在回滚前按稳定身份核对旧角色/状态，防止恢复已撤销的访问。切换或回滚都不能让同一个入口接受不属于自己的受众。
6. **最终退役（另一次授权）。** 观察期结束、无客户端和运维流程仍依赖旧注册后，先停用、再移除 `platform-web`、`platform-api`、`mcp-gateway`、`platform-admin` 和两个测试注册，清理旧镜像中的回退配置。统一模式不会写入真实本地密码哈希；现有哈希列仅留给回滚，旧链路彻底退役后单独发布删除旧代码及密码列的迁移。在此之前不要擦除旧密码数据。

## 隔离 Docker 验收

以下命令从仓库根目录执行，仅使用本机端口 13463（同源入口）和 13465（Codex 回跳），以及测试数据。镜像由仓库 Dockerfile 构建；已有刚验证过的本地镜像时可用 `--no-build`。不要在真实数据库执行测试 SQL。

```sh
check=scripts/dev/keycloak-unified-check
python3 "$check/prepare.py"
docker compose --project-directory "$PWD" -f "$check/compose.yml" up -d --build
# /api/health、Keycloak discovery 和 /admin/login 就绪后初始化夹具
docker compose --project-directory "$PWD" -f "$check/compose.yml" exec -T db psql -v ON_ERROR_STOP=1 -U fixture -d fixture < "$check/fixtures.sql"
python3 "$check/verify.py"
```

使用空白 Codex 容器验证 OAuth，不要设置 Bearer 或预先创建 OAuth 配置：

```sh
docker build -f "$check/Dockerfile.codex" -t range-keycloak-unified:codex .
docker run -d --name range-unified-acceptance-codex --network range-unified-acceptance_default \
  -p 127.0.0.1:13465:13465 -v "$PWD/$check/codex-relay.cjs:/opt/relay.cjs:ro" \
  range-keycloak-unified:codex node /opt/relay.cjs
docker exec range-unified-acceptance-codex codex mcp list
docker exec -it range-unified-acceptance-codex codex mcp add isolated-range --url http://127.0.0.1:13463/mcp
docker exec -it range-unified-acceptance-codex codex mcp login isolated-range
docker exec -i range-unified-acceptance-codex node - < "$check/verify-codex.cjs"
```

容器没有图形界面时，将 CLI 输出的**授权网址**在宿主浏览器打开，用测试账号 `fixture-member`／`fixture-only-2026-strong` 登录并点「授权」。无需复制授权码或访问令牌。只读验证会在独立 Codex 容器内读取该命令正常保存的凭据，不输出它。跑完销毁本次测试容器和测试数据库卷。
