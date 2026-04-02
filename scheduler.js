const cron = require('node-cron');
const db = require('./db');
const { sendNotifications } = require('./notifier');

let cronJob = null;

function start() {
    cronJob = cron.schedule('* * * * *', async () => {
        try {
            const now = new Date();
            const reminders = db.all(
                'SELECT * FROM reminders WHERE status = 0 AND datetime(remind_time) <= datetime(?)',
                [now.toISOString()]
            );

            for (const reminder of reminders) {
                console.log(`⏰ 正在发送提醒: ${reminder.title}`);
                try {
                    const results = await sendNotifications(reminder);

                    for (const result of results) {
                        db.run(
                            'INSERT INTO notification_logs (reminder_id, platform, success, message) VALUES (?, ?, ?, ?)',
                            [reminder.id, result.platform, result.success ? 1 : 0, JSON.stringify(result.result || result.error || '')]
                        );
                    }

                    if (reminder.cycle_type === 'once') {
                        db.run('UPDATE reminders SET status = 1 WHERE id = ?', [reminder.id]);
                    } else {
                        const nextTime = calculateNextRemindTime(reminder.remind_time, reminder.cycle_type);
                        if (nextTime) {
                            db.run('UPDATE reminders SET remind_time = ?, status = 0 WHERE id = ?', [nextTime.toISOString(), reminder.id]);
                        }
                    }
                    console.log(`✅ 提醒已发送: ${reminder.title}`);
                } catch (error) {
                    console.error(`❌ 发送提醒失败: ${reminder.title}`, error);
                }
            }
        } catch (error) {
            console.error('❌ 定时任务执行出错:', error);
        }
    });
    console.log('⏱️  内置定时任务调度器已启动（每分钟检查一次）');
}

function stop() {
    if (cronJob) { cronJob.stop(); console.log('⏱️  定时任务调度器已停止'); }
}

function calculateNextRemindTime(currentTimeStr, cycleType) {
    const date = new Date(currentTimeStr);
    switch (cycleType) {
        case 'weekly': return new Date(date.getTime() + 7 * 24 * 60 * 60 * 1000);
        case 'monthly': {
            const y = date.getFullYear(), m = date.getMonth(), d = date.getDate();
            const h = date.getHours(), mi = date.getMinutes(), s = date.getSeconds();
            let n = new Date(y, m + 1, d, h, mi, s);
            if (n.getMonth() !== (m + 1) % 12) n = new Date(y, m + 2, 0, h, mi, s);
            return n;
        }
        case 'yearly': {
            const y = date.getFullYear(), m = date.getMonth(), d = date.getDate();
            const h = date.getHours(), mi = date.getMinutes(), s = date.getSeconds();
            let n = new Date(y + 1, m, d, h, mi, s);
            if (m === 1 && d === 29) {
                const ny = y + 1;
                if (!((ny % 4 === 0 && ny % 100 !== 0) || ny % 400 === 0)) n = new Date(ny, 1, 28, h, mi, s);
            }
            return n;
        }
        default: return null;
    }
}

module.exports = { start, stop };
