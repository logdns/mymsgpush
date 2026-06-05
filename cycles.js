const CYCLE_TEXT = {
    once: '单次提醒',
    weekly: '每周循环',
    monthly: '每月循环',
    quarterly: '每3个月循环',
    half_yearly: '每6个月循环',
    yearly: '每年循环'
};

function addMonthsClamped(date, months) {
    const year = date.getFullYear();
    const month = date.getMonth();
    const day = date.getDate();
    const hours = date.getHours();
    const minutes = date.getMinutes();
    const seconds = date.getSeconds();
    const next = new Date(year, month + months, day, hours, minutes, seconds);

    if (next.getMonth() !== (month + months) % 12) {
        return new Date(year, month + months + 1, 0, hours, minutes, seconds);
    }

    return next;
}

function calculateNextRemindTime(currentTimeStr, cycleType) {
    const date = new Date(currentTimeStr);
    if (Number.isNaN(date.getTime())) return null;

    switch (cycleType) {
        case 'weekly':
            return new Date(date.getTime() + 7 * 24 * 60 * 60 * 1000);
        case 'monthly':
            return addMonthsClamped(date, 1);
        case 'quarterly':
            return addMonthsClamped(date, 3);
        case 'half_yearly':
            return addMonthsClamped(date, 6);
        case 'yearly':
            return addMonthsClamped(date, 12);
        default:
            return null;
    }
}

function getCycleText(cycleType) {
    return CYCLE_TEXT[cycleType] || CYCLE_TEXT.once;
}

module.exports = { CYCLE_TEXT, calculateNextRemindTime, getCycleText };
