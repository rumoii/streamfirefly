import { fork } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const filename = fileURLToPath(import.meta.url);
process.on('disconnect', () => process.exit(0));
if (process.argv.includes('--worker')) {
  setInterval(() => {}, 1000);
  process.send({ ready: true });
} else {
  const workers = new Set();
  let readySent = false, churn;
  function addWorker() {
    const worker = fork(filename, ['--worker'], { windowsHide: true, stdio: ['ignore', 'ignore', 'ignore', 'ipc'] });
    workers.add(worker);
    worker.once('error', error => { process.send({ error: error.message }); process.exitCode = 1; });
    worker.once('message', () => {
      worker.ready = true;
      if (!readySent && workers.size === 3 && [...workers].every(item => item.ready)) { readySent = true; process.send({ ready: true }); }
    });
    worker.once('exit', () => {
      workers.delete(worker);
      if (churn) addWorker();
      else if (process.connected) process.send({ error: 'Stable diagnostic worker exited unexpectedly' });
    });
  }
  for (let index = 0; index < 3; index++) addWorker();
  process.on('message', message => {
    if (message === 'churn' && !churn) {
      churn = setInterval(() => { const worker = [...workers].find(item => item.ready && !item.killed); if (worker) worker.kill(); }, 1000);
      [...workers][0].kill();
      process.send({ phase: 'churn' });
    }
  });
}
