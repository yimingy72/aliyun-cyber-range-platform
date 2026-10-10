from pathlib import Path
cvm=Path('/source/tencentcloud/services/cvm/resource_tc_instance.go').read_text()
eip=Path('/source/tencentcloud/services/cvm/resource_tc_eip.go').read_text()
nat=Path('/source/tencentcloud/services/vpc/resource_tc_nat_gateway.go').read_text()
assert 'request.ClientToken = &clientToken' in cvm and 'clientToken := rangeInstanceClientToken(d)' in cvm
assert 'request.ActionTimer = &cvm.ActionTimer{TimerAction: helper.String("TerminateInstances"), ActionTime: helper.String(value.(string))}' in cvm
assert 'request.ClientToken = &clientToken' in eip and 'clientToken := rangeInstanceClientToken(d)' in eip
assert 'tags["PlatformManaged"] == "true" && tags["CloudProvider"] == "tencent_cloud"' in nat
assert 'return resource.NonRetryableError(e)' in nat[nat.index('CreateNatGateway(request)'):nat.index('natGatewayId :=')]
atomic_nat_tags = nat[nat.index('if v := helper.GetTags(d, "tags")'):nat.index('var response *vpc.CreateNatGatewayResponse')]
assert 'request.Tags = append(request.Tags, &tag)' in atomic_nat_tags
print('Verified persisted CVM/EIP tokens, atomic expiry and guarded NAT creation.')
