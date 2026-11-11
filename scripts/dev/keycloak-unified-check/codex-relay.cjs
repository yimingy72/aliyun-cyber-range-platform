const net = require('node:net');
const os = require('node:os');
const address = Object.values(os.networkInterfaces()).flat().find(x => !x.internal && x.family === 'IPv4').address;
function relay(bind, port, host, targetPort) {
  net.createServer(client => {
    const upstream = net.connect({ host, port: targetPort });
    client.on('error', () => upstream.destroy());
    upstream.on('error', () => client.destroy());
    client.pipe(upstream).pipe(client);
  }).listen(port, bind);
}
relay('127.0.0.1', 13463, 'gateway', 80);
relay(address, 13465, '127.0.0.1', 13465);
