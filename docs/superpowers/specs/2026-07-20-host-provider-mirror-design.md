# 宿主机 OpenTofu Provider 缓存设计

## 目标

将 Alibaba Cloud OpenTofu provider 的下载从 API 镜像构建阶段移到宿主机预下载阶段，避免构建时依赖 GitHub Releases。缓存文件保存在仓库的 `.local/provider-mirror/`，由 API 和 worker 以只读方式挂载。

## 范围

- 新增宿主机下载脚本，下载 `alicloud` provider 1.282.0 ZIP 并校验既有 SHA-256。
- 缓存采用 OpenTofu filesystem mirror 目录结构。
- Compose 将宿主机缓存目录只读挂载到 API 和 worker，并保留现有容器内路径与 `ALICLOUD_PROVIDER_ZIP_PATH` 合约。
- API Dockerfile 不再从 GitHub Releases 下载 provider ZIP。
- 保留 pnpm registry 与重试设置；不恢复网络并发上限。

## 不在范围内

- 不提交 provider ZIP 或离线镜像包到 Git。
- 不改变 OpenTofu provider 版本、校验和或运行时 provider 解析逻辑。
- 不执行阿里云资源创建。

## 数据流

1. 开发者运行下载脚本。
2. 脚本在 `.local/provider-mirror/registry.opentofu.org/aliyun/alicloud/` 写入已校验的 `terraform-provider-alicloud_1.282.0_linux_amd64.zip`。
3. `docker compose` 将 `.local/provider-mirror/` 只读挂载到 `/var/lib/cyber-range/provider-mirror`。
4. API 与 worker 使用既有 `ALICLOUD_PROVIDER_ZIP_PATH` 读取缓存；其余 OpenTofu mirror 配置保持不变。

## 错误处理

- 已存在且校验通过：脚本直接成功，不重新下载。
- 文件缺失或校验失败：脚本下载到临时文件，校验成功后再原子替换缓存文件。
- 下载失败：脚本返回非零状态，不写入不完整缓存。
- Compose 启动前缓存缺失：容器的 provider seed 脚本输出明确的缓存路径和下载命令，而不是联网下载。

## 验证

- 自动化测试覆盖缓存命中、校验失败和缺失缓存的失败信息。
- 使用 Docker 构建 API、MCP、Web 镜像，确认 API Dockerfile 不包含 GitHub Releases 下载层。
- 在容器中检查 provider mirror 路径与只读挂载可访问。
