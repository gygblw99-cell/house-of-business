module.exports = {
  apps: [
    {
      name:        'hob-backend',
      script:      './src/index.js',
      instances:   1,
      autorestart: true,
      watch:       false,
      max_memory_restart: '500M',
      // Prevent infinite crash loop: back off exponentially, stop after 10 restarts
      max_restarts:            10,
      restart_delay:           4000,
      exp_backoff_restart_delay: 100,
      // Log config
      merge_logs:      true,
      log_date_format: 'YYYY-MM-DD HH:mm:ss Z',
      error_file:      './logs/backend-error.log',
      out_file:        './logs/backend-out.log',
      env: { NODE_ENV: 'production' },
    },
    {
      name:        'hob-charge',
      script:      './scripts/charge_recurring.js',
      instances:   1,
      autorestart: false,
      cron_restart: '0 8 1 * *', // 1st of each month at 08:00
      watch:       false,
      error_file:  './logs/charge-error.log',
      out_file:    './logs/charge-out.log',
      env: { NODE_ENV: 'production' },
    },
    {
      name:        'hob-backup',
      script:      './scripts/backup_db.js',
      instances:   1,
      autorestart: false,
      cron_restart: '0 3 * * *', // every day at 03:00
      watch:       false,
      error_file:  './logs/backup-error.log',
      out_file:    './logs/backup-out.log',
      env: { NODE_ENV: 'production' },
    },
  ],
};
