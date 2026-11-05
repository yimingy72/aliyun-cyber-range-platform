# 墨攻场景转换

`convert_mogong_scenarios.py` 只读取私有导出文件并生成转换候选，不连接云、不导入模板、不创建资源。输入包括墨攻场景详情及 network-config、镜像元数据，以及当前工作空间经 MCP 查询的镜像资产与云目录。导出数据不得提交到 Git。

转换保留节点 ID、坐标、CPU/内存、镜像完整 ID、网段、全部网卡、安全组、ACL、SNAT、DNAT 和启动顺序。公共镜像使用完整的云镜像 ID 匹配，不以 `m-` 前缀判断。ACL/安全组按墨攻编辑器的方向选择源或目标地址；交换机默认兜底优先级 9999 在没有顺序冲突时转换为 1000。全局 DNS 仅在全部客户机均为 Windows 时转换到全部网卡；涉及其它操作系统时停止该场景转换。

以下情况不收录为模板：来源已停用，镜像停用或未精确匹配，节点、网卡或网段缺失，悬空或平台不支持的连线，以及不能等价表达的配置。转换候选必须再通过平台完整拓扑编译；公网端口冲突、IP 冲突、网段重叠等编译失败时也不收录。

通过编译后，只能使用当前空间的 MCP 工具收录必要的私有镜像依赖及创建私有模板。使用来源场景 ID 核对已导入记录，结果未知先查询原模板，不重复创建。保存模板不代表已验证云端库存或启动成功，实际创建时仍需精确匹配可售机型和网卡容量。

定向离线回归：

```sh
docker run --rm --network none \
  --mount "type=bind,source=$PWD/scripts/migration,target=/tools,readonly" \
  python:3.12-alpine python -m unittest discover -s /tools -p 'test_convert_mogong_scenarios.py'
```
