/* PM2: sajt i radnik kamera (pm2 start deploy/ecosystem.config.js && pm2 save) */
module.exports = { apps: [
  { name: 'granice', script: 'server/server.js', cwd: __dirname + '/..', env: { NODE_ENV: 'production' }, max_memory_restart: '600M' },
  { name: 'granice-kamere', script: 'server/kamere.js', cwd: __dirname + '/..', env: { NODE_ENV: 'production' } },
] };
