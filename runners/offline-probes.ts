/** Reviewed, owned probes only. No caller-supplied scripts, targets or secrets. */
const controls = `
import assert from 'node:assert/strict';
import fs from 'node:fs';
import net from 'node:net';
import dgram from 'node:dgram';
import os from 'node:os';
const read = p => fs.readFileSync(p, 'utf8').trim();
assert.equal(process.getuid(), 65534);
assert.deepEqual(Object.keys(process.env).sort(), ['HOME','LANG','PATH','TMPDIR','UV_USE_IO_URING','XDG_CACHE_HOME'].sort());
assert.equal(process.env.HOME, '/scratch');
assert.equal(process.env.UV_USE_IO_URING, '0');
assert.equal(read('/sys/fs/cgroup/memory.max'), '134217728');
assert.equal(read('/sys/fs/cgroup/memory.swap.max'), '0');
assert.equal(read('/sys/fs/cgroup/pids.max'), '32');
assert.equal(read('/sys/fs/cgroup/cpu.max'), '50000 100000');
assert.match(read('/proc/self/status'), /CapEff:\\s+0+\\n/);
assert.match(read('/proc/self/status'), /NoNewPrivs:\\s+1\\n/);
assert.match(read('/proc/self/status'), /Seccomp:\\s+2\\n/);
assert.match(read('/proc/self/limits'), /Max open files\\s+128\\s+128/);
assert.match(read('/proc/self/limits'), /Max file size\\s+1048576\\s+1048576/);
assert.match(read('/proc/self/limits'), /Max cpu time\\s+4\\s+4/);
assert.match(read('/proc/self/limits'), /Max core file size\\s+0\\s+0/);
assert.throws(() => fs.writeFileSync('/tmp/offline-probe', 'x'), e => e.code==='EROFS');
assert(!fs.existsSync('/var/run/docker.sock'));
assert(!fs.existsSync('/scratch/previous-run'));
fs.writeFileSync('/scratch/previous-run', 'owned fixture');
assert.deepEqual(Object.keys(os.networkInterfaces()), ['lo']);
const denied = host => new Promise((resolve, reject) => {
  const s = net.connect({host,port:443});
  const t = setTimeout(() => {s.destroy();reject(new Error('network denial not observed'));}, 800);
  s.on('connect', () => {clearTimeout(t);s.destroy();reject(new Error('unexpected connection'));});
  s.on('error', e => {clearTimeout(t);assert(['ENETUNREACH','EHOSTUNREACH','ECONNREFUSED'].includes(e.code));resolve();});
});
// Documentation-only IPs, metadata address and IPv6: no packet can leave network=none.
await denied('192.0.2.1'); await denied('169.254.169.254'); await denied('2001:db8::1');
await new Promise((resolve, reject) => {
 const s=dgram.createSocket('udp4'); s.send(Buffer.from('fixture'),53,'192.0.2.1',e=>{
  s.close(); if(e && ['ENETUNREACH','EHOSTUNREACH'].includes(e.code)) resolve(); else reject(new Error('UDP not denied'));
 });
});
// Also demonstrate useful local traffic in the isolated namespace.
await new Promise((resolve,reject)=>{
 const server=net.createServer(s=>s.end('owned-fixture'));
 server.on('error',reject); server.listen(0,'127.0.0.1',()=>{
  let data=''; const client=net.connect(server.address().port,'127.0.0.1');
  client.on('data',b=>data+=b);client.on('end',()=>{assert.equal(data,'owned-fixture');server.close(resolve);});client.on('error',reject);
 });
});
console.log(JSON.stringify({check:'controls',passed:true,freshScratch:true,tcpDenied:true,udpDenied:true,localFixture:true}));
`;

const disk = `
import assert from 'node:assert/strict';import fs from 'node:fs';
let denied=false;for(let i=0;i<10;i++){try{fs.writeFileSync('/scratch/chunk-'+i,Buffer.alloc(1048576,1));}catch(e){assert.equal(e.code,'ENOSPC');denied=true;break;}}
assert(denied);console.log(JSON.stringify({check:'scratch-limit',passed:true}));
`;
const processes = `
import assert from 'node:assert/strict';import {spawn} from 'node:child_process';import {once} from 'node:events';
const children=[];let denied=false;
try{for(let i=0;i<40;i++){
 const c=spawn('/bin/sleep',['8'],{stdio:'ignore',env:{}});children.push(c);
 try{await once(c,'spawn');}catch(e){assert.equal(e.code,'EAGAIN');denied=true;break;}
}assert(denied);console.log(JSON.stringify({check:'process-limit',passed:true}));}
finally{for(const c of children)c.kill('SIGKILL');}
`;
const memory = `
import assert from 'node:assert/strict';import fs from 'node:fs';import {spawn} from 'node:child_process';import {once} from 'node:events';
const c=spawn('/usr/local/bin/node',['-e','const a=[];for(let i=0;i<40;i++)a.push(Buffer.alloc(8388608,1));setTimeout(()=>{},5000)'],{stdio:'ignore',env:{}});
const [code,signal]=await once(c,'exit');
assert.equal(signal,'SIGKILL');assert.match(fs.readFileSync('/sys/fs/cgroup/memory.events','utf8'),/oom_kill [1-9]/);
console.log(JSON.stringify({check:'memory-limit',passed:true}));
`;
const file = `
import assert from 'node:assert/strict';import fs from 'node:fs';import {spawn} from 'node:child_process';import {once} from 'node:events';
const c=spawn('/usr/local/bin/node',['-e',"require('fs').writeFileSync('/scratch/large',Buffer.alloc(2097152,1))"],{stdio:'ignore',env:{}});
const [code,signal]=await once(c,'exit');assert(code!==0 || signal);assert(fs.statSync('/scratch/large').size<=1048576);
console.log(JSON.stringify({check:'file-limit',passed:true}));
`;

const cpu = `
import assert from 'node:assert/strict';import fs from 'node:fs';
const throttled=()=>Number(fs.readFileSync('/sys/fs/cgroup/cpu.stat','utf8').match(/nr_throttled (\\d+)/)[1]);
const before=throttled();const until=Date.now()+1200;while(Date.now()<until){};
assert(throttled()>before);console.log(JSON.stringify({check:'cpu-throttled',passed:true}));
`;

export const offlineProbes = {
  controls,
  disk,
  processes,
  memory,
  file,
  cpu,
  wait: 'setInterval(()=>{},1000);',
  output: "for(let i=0;i<128;i++)process.stdout.write('x'.repeat(8192));setInterval(()=>{},1000);",
} as const;
export type OfflineProbe = keyof typeof offlineProbes;
