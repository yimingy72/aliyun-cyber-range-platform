#!/usr/bin/env bash
set -euo pipefail

: "${OPENCLI_PROFILE:?请设置已登录墨攻的 OPENCLI_PROFILE}"
root_dir="$(cd "$(dirname "$0")/../.." && pwd)"
output_path="${MOGONG_IMAGE_CATALOG_OUTPUT:-$root_dir/.local/mogong/image-catalog.json}"
mkdir -p "$(dirname "$output_path")"
umask 077
session="mogong-catalog-$$"
tmp_file="$(mktemp)"
cleanup() {
  rm -f "$tmp_file"
  opencli browser "$session" close >/dev/null 2>&1 || true
}
trap cleanup EXIT

opencli browser "$session" open https://reversi-mgt.chaitin.net/targets/image >/dev/null
script='(async()=>{
  const size=500, items=[]; let total;
  for(let page=1;;page++){
    const response=await fetch(`/api/target/image?page=${page}&size=${size}`,{credentials:"include"});
    if(!response.ok) throw Error(`HTTP ${response.status}`);
    const result=await response.json(), data=result.data;
    if(result.code!==200 || !data || data.current!==page || data.size!==size || !Number.isSafeInteger(data.total) || !Array.isArray(data.items)) throw Error("Invalid page");
    if(total===undefined) total=data.total;
    if(total!==data.total) throw Error("Total changed during collection");
    items.push(...data.items.map(item=>({id:item.id,name:item.name,type:item.image_type,imageId:item.image_type==="vm" && /^m-[a-z0-9]+$/i.test(item.external_resource_id||"") ? item.external_resource_id : null,active:item.active,status:item.status,creator:[item.create_user?.name,item.create_user?.username].find(value=>typeof value==="string" && value.trim())?.trim() || null})));
    if(items.length>=total) break;
    if(!data.items.length) throw Error("Incomplete page");
  }
  if(items.length!==total || new Set(items.map(item=>item.id)).size!==total) throw Error("Incomplete or duplicate results");
  return {capturedAt:new Date().toISOString(),total,items};
})()'
OPENCLI_BROWSER_COMMAND_TIMEOUT=120 opencli browser "$session" eval "$script" > "$tmp_file"
node - "$tmp_file" "$output_path" <<'NODE'
const fs = require('fs');
const catalog = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'));
if (!Array.isArray(catalog.items) || catalog.items.length !== catalog.total || catalog.items.some(item =>
  !Number.isSafeInteger(item.id) || typeof item.name !== 'string' || !item.name.trim() || typeof item.type !== 'string' ||
  typeof item.active !== 'boolean' || typeof item.status !== 'string' || !(item.creator === null || typeof item.creator === 'string') || !(item.imageId === null || /^m-[a-z0-9]+$/i.test(item.imageId)))) {
  throw new Error('Invalid catalog; the previous snapshot was retained');
}
const target = process.argv[3];
const temporary = `${target}.tmp-${process.pid}`;
try {
  fs.writeFileSync(temporary, JSON.stringify(catalog) + '\n');
  fs.renameSync(temporary, target);
} finally {
  fs.rmSync(temporary, { force: true });
}
console.log(`已更新 ${catalog.total} 条墨攻镜像目录记录。`);
NODE
