// Upgrade old fixtures to ECS's separate DescribeDisks response. Production never reads BlockDeviceMappings.
export function withEcsResponseContract(implementation: typeof fetch): typeof fetch {
  const disks = new Map<string, string[]>();
  return async (input, init) => {
    const query = new URLSearchParams(init?.method === 'POST' ? String(init.body ?? '') : new URL(String(input)).search);
    const action = query.get('Action');
    if (action === 'DescribeDisks') {
      const id = query.get('InstanceId')!;
      return new Response(JSON.stringify({Disks:{Disk:(disks.get(id) ?? [`d-${id}`]).map(DiskId=>({DiskId}))}}),{status:200});
    }
    const response = await implementation(input, init);
    if (action !== 'DescribeInstances' || !response.ok) return response;
    const body = await response.json();
    if (!body.Instances) body.Instances = {Instance:[]};
    for (const instance of body.Instances.Instance ?? []) {
      if (instance.BlockDeviceMappings) {
        disks.set(instance.InstanceId, instance.BlockDeviceMappings.BlockDeviceMapping.map((disk:{DiskId:string})=>disk.DiskId));
        delete instance.BlockDeviceMappings;
      }
    }
    return new Response(JSON.stringify(body),{status:response.status});
  };
}
