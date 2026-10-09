// Upgrade old fixtures to separate disks and multi-ID queries. Production never reads BlockDeviceMappings.
export function withEcsResponseContract(implementation: typeof fetch): typeof fetch {
  const disks = new Map<string, string[]>();
  return async (input, init) => {
    const query = new URLSearchParams(init?.method === 'POST' ? String(init.body ?? '') : new URL(String(input)).search);
    const action = query.get('Action');
    if (action === 'DescribeDisks') {
      const id = query.get('InstanceId')!;
      return new Response(JSON.stringify({Disks:{Disk:(disks.get(id) ?? [`d-${id}`]).map(DiskId=>({DiskId}))}}),{status:200});
    }
    const ids = action === 'DescribeInstances' && query.get('InstanceIds')
      ? JSON.parse(query.get('InstanceIds')!) as string[] : [];
    const responses = ids.length > 1 ? await Promise.all(ids.map((id) => {
      const url = new URL(String(input));
      url.searchParams.set('InstanceIds', JSON.stringify([id]));
      return implementation(url.toString(), init);
    })) : [await implementation(input, init)];
    const response = responses.find((value) => !value.ok) ?? responses[0];
    if (action !== 'DescribeInstances' || !response.ok) return response;
    const bodies = await Promise.all(responses.map((value) => value.json()));
    const body = bodies.find((value) => value.Code) ?? { ...bodies[0], Instances: { Instance: bodies.flatMap((value) => value.Instances?.Instance ?? []) } };
    if (!body.Instances) body.Instances = {Instance:[]};
    body.RequestId ??= 'synthetic-ecs-request';
    body.PageNumber ??= Number(query.get('PageNumber') ?? 1);
    body.PageSize ??= Number(query.get('PageSize') ?? 100);
    if (ids.length) {
      body.Instances.Instance = body.Instances.Instance.filter((value:{InstanceId:string}) => ids.includes(value.InstanceId));
      body.TotalCount = body.Instances.Instance.length;
    } else body.TotalCount ??= body.Instances.Instance.length;
    for (const instance of body.Instances.Instance ?? []) {
      if (instance.BlockDeviceMappings) {
        disks.set(instance.InstanceId, instance.BlockDeviceMappings.BlockDeviceMapping.map((disk:{DiskId:string})=>disk.DiskId));
        delete instance.BlockDeviceMappings;
      }
    }
    return new Response(JSON.stringify(body),{status:response.status});
  };
}
