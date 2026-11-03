const path = require('path');
const ROOT = __dirname;

module.exports = {
  apps: [
    {
      name: 'hob-backend',
      script: 'src/index.js',
      cwd: path.join(ROOT, 'backend'),
      env: { NODE_ENV: 'development' },
      env_production: { NODE_ENV: 'production' },
      autorestart: true,
      max_restarts: 5,
      min_uptime: '30s',
    },
    {
      name: 'hob-web',
      script: 'node_modules/next/dist/bin/next',
      args: 'dev -H 0.0.0.0 -p 3002',
      cwd: path.join(ROOT, 'web'),
      env: { NODE_ENV: 'development' },
      env_production: {
        NODE_ENV: 'production',
        args: 'start -H 0.0.0.0 -p 3002',
      },
      autorestart: true,
      max_restarts: 5,
      min_uptime: '15s',
    },
    {
      name: 'hob-website',
      script: 'node_modules/next/dist/bin/next',
      args: 'dev -H :: -p 4000',
      cwd: path.join(ROOT, 'website'),
      env: { NODE_ENV: 'development' },
      env_production: {
        NODE_ENV: 'production',
        args: 'start -H 0.0.0.0 -p 4000',
      },
      autorestart: true,
      max_restarts: 5,
      min_uptime: '15s',
    },
  ],
};
