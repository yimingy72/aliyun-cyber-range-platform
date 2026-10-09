import { expectedCosBucketTags } from '../../src/admin/tencent-cos-proof';
export type FakeCosBucket = { name: string; createdAt: string; tags: Record<string,string>; exists: boolean; objects: Map<string,{ owner: string; context: string; job: string; size: number; etag: string }>; publicAcl?: boolean; versions?: string; multipart?: string };
export function fakeCos() {
  const buckets = new Map<string, FakeCosBucket>(); let creates = 0, deletes = 0, unknownCreate = false, unknownDelete = false;
  const xml = (value: string) => value.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('"', '&quot;');
  const response = (body = '', status = 200, extra: Record<string,string> = {}) => new Response(body, { status, headers: { 'x-cos-request-id': 'fixture-request', ...extra } });
  const owner = 'qcs::cam::uin/100001:uin/100001';
  const fetch = jest.spyOn(global, 'fetch').mockImplementation(async (url, init) => {
    const uri = new URL(String(url)), method = init?.method ?? 'GET', headers = init?.headers as Record<string,string>;
    if (uri.hostname === 'cam.tencentcloudapi.com') return new Response(JSON.stringify({ Response: { OwnerUin: '100001', Uin: '100009', AppId: 1250000000, RequestId: 'fixture-iam' } }), { status: 200 });
    const name = uri.hostname.split('.cos.')[0];
    if (uri.hostname === 'service.cos.myqcloud.com') {
      const rows = [...buckets.values()].filter(bucket => bucket.exists && bucket.tags[uri.searchParams.get('tagkey')!] === uri.searchParams.get('tagvalue'));
      return response(`<ListAllMyBucketsResult><Owner><ID>${owner}</ID></Owner><Buckets>${rows.map(bucket => `<Bucket><Name>${bucket.name}</Name><Location>ap-shanghai</Location><CreationDate>${bucket.createdAt}</CreationDate></Bucket>`).join('')}</Buckets><NextMarker></NextMarker></ListAllMyBucketsResult>`);
    }
    let bucket = buckets.get(name);
    if (method === 'PUT' && uri.pathname === '/' && !uri.search) {
      creates++; const tags = Object.fromEntries(new URLSearchParams(headers['x-cos-tagging']));
      bucket = { name, createdAt: new Date().toISOString(), tags, exists: true, objects: new Map() }; buckets.set(name, bucket);
      if (unknownCreate) { unknownCreate = false; throw new Error('unknown create fixture'); } return response();
    }
    if (!bucket?.exists) return response('', 404);
    if (method === 'HEAD' && uri.pathname === '/') return response();
    if (method === 'DELETE' && uri.pathname === '/') {
      deletes++; bucket.exists = false; if (unknownDelete) { unknownDelete = false; throw new Error('unknown delete fixture'); } return response();
    }
    if (method === 'HEAD') { const object = bucket.objects.get(decodeURIComponent(uri.pathname.slice(1))); return object ? response('', 200, {
      'x-cos-meta-platform-image-owner': object.owner, 'x-cos-meta-platform-image-job': object.job, 'x-cos-meta-platform-cloud-context': object.context,
      'content-length': String(object.size), etag: object.etag,
    }) : response('', 404); }
    if (uri.searchParams.has('acl')) return response(`<AccessControlPolicy><Owner><ID>${owner}</ID></Owner><AccessControlList><Grant><Grantee><ID>${bucket.publicAcl ? 'foreign' : owner}</ID></Grantee><Permission>FULL_CONTROL</Permission></Grant></AccessControlList></AccessControlPolicy>`);
    if (uri.searchParams.has('policy')) return response('', 404);
    if (uri.searchParams.has('tagging')) return response(`<Tagging><TagSet>${Object.entries(bucket.tags).map(([key,value]) => `<Tag><Key>${key}</Key><Value>${xml(value)}</Value></Tag>`).join('')}</TagSet></Tagging>`);
    if (uri.searchParams.has('cors')) return response();
    if (uri.searchParams.has('versions')) return response(`<ListVersionsResult><Name>${name}</Name><IsTruncated>false</IsTruncated>${bucket.versions ?? ''}</ListVersionsResult>`);
    if (uri.searchParams.has('uploads')) return response(`<ListMultipartUploadsResult><Bucket>${name}</Bucket><IsTruncated>false</IsTruncated>${bucket.multipart ?? ''}</ListMultipartUploadsResult>`);
    return response(`<ListBucketResult><Name>${name}</Name><IsTruncated>false</IsTruncated>${[...bucket.objects.keys()].map(key => `<Contents><Key>${xml(key)}</Key></Contents>`).join('')}</ListBucketResult>`);
  });
  return { buckets, fetch, get creates() { return creates; }, get deletes() { return deletes; }, unknownCreate() { unknownCreate = true; }, unknownDelete() { unknownDelete = true; }, restore() { fetch.mockRestore(); } };
}
