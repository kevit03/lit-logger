// LitCopy: every encouraging line LIT shows, in one place.
//
// Three voices, picked in Settings (prefs.coachVoice):
//   gentle  soft and patient
//   coach   warm and direct (the default)
//   drill   firm and brief, never insulting
// Plain English for people who are not technical. No emoji, no shaming: LIT
// never says a streak "failed", never shows a zero-day streak as a headline,
// and never leads with a decline.
//
// Loads in the popup and other extension pages (window), the service worker
// (self), content scripts, and node tests (module.exports).
const LitCopy = (() => {
  const VOICES = ['gentle', 'coach', 'drill'];
  const WORDS = ['zero', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine', 'ten'];

  function voiceOf(v) {
    return VOICES.includes(v) ? v : 'coach';
  }

  function int(n) {
    const v = parseInt(n, 10);
    return Number.isFinite(v) && v > 0 ? v : 0;
  }

  function word(n) {
    return n >= 0 && n <= 10 ? WORDS[n] : String(n);
  }

  function capWord(n) {
    const w = word(n);
    return w.charAt(0).toUpperCase() + w.slice(1);
  }

  // The built-in jobs tracker stores its unit as 'jobs'; people send
  // applications, so say that.
  function unitPlural(unit) {
    const u = typeof unit === 'string' ? unit.trim().toLowerCase() : '';
    if (!u || u === 'jobs' || u === 'job' || u === 'items' || u === 'entries') return 'applications';
    return u;
  }

  function unitFor(unit, n) {
    const u = unitPlural(unit);
    if (n !== 1) return u;
    if (/ies$/.test(u)) return u.slice(0, -3) + 'y';
    if (/(ss|sh|ch|x)es$/.test(u)) return u.slice(0, -2);
    if (/s$/.test(u) && !/ss$/.test(u)) return u.slice(0, -1);
    return u;
  }

  function pick(voice, lines) {
    return lines[voiceOf(voice)] || lines.coach;
  }

  // ----- Counter headline ---------------------------------------------------

  function headline(opts) {
    const o = opts || {};
    const count = int(o.count);
    const goal = Math.max(1, int(o.goal) || 1);
    const voice = voiceOf(o.voice);
    if (count === 0) {
      return pick(voice, {
        gentle: 'Ready when you are',
        coach: 'Ready when you are',
        drill: 'Time to get the first one in'
      });
    }
    if (count >= goal) {
      if (count > goal) {
        return pick(voice, {
          gentle: 'Locked in, and then some.',
          coach: 'Locked in for today. Everything else is extra.',
          drill: 'Goal done. Extra reps count.'
        });
      }
      return pick(voice, {
        gentle: 'Locked in for today. Nicely done.',
        coach: 'Locked in for today.',
        drill: 'Locked in. Good work.'
      });
    }
    const left = goal - count;
    const more = left === 1 ? 'One more locks it in.' : capWord(left) + ' more locks it in.';
    return pick(voice, {
      gentle: 'That\'s ' + count + ' so far. ' + more,
      coach: 'Nice, that\'s ' + count + '. ' + more,
      drill: count + ' down. ' + capWord(left) + ' to go.'
    });
  }

  // ----- Auto-log toast -----------------------------------------------------

  function toast(opts) {
    const o = opts || {};
    const count = int(o.count);
    const goal = Math.max(1, int(o.goal) || 1);
    const voice = voiceOf(o.voice);
    const streakDays = int(o.streak);
    const unitN = unitFor(o.unit, count);
    const one = unitFor(o.unit, 1);
    let title;
    let sub;
    if (count >= goal && count - 1 < goal) {
      title = pick(voice, {
        gentle: 'Goal met for today',
        coach: 'Locked in: ' + count + ' of ' + goal,
        drill: 'Goal done: ' + count + ' of ' + goal
      });
      sub = streakDays > 1
        ? 'Day ' + streakDays + ' in a row. Keep it rolling.'
        : pick(voice, {
          gentle: 'That\'s a full day of ' + unitPlural(o.unit) + '. Be proud of it.',
          coach: 'Anything more today is a bonus.',
          drill: 'Anything more is extra credit.'
        });
    } else if (count > goal) {
      title = count + ' ' + unitN + ' today';
      sub = pick(voice, {
        gentle: 'Past your goal. Rest whenever you like.',
        coach: 'Past your goal. That extra effort adds up.',
        drill: 'Past your goal. Keep the pace.'
      });
    } else {
      const left = goal - count;
      title = o.firstOfDay || count === 1
        ? pick(voice, {
          gentle: 'First ' + one + ' of the day',
          coach: 'First one of the day is in',
          drill: 'First ' + one + ' logged'
        })
        : pick(voice, {
          gentle: count + ' ' + unitN + ' today',
          coach: 'Nice, that\'s ' + count + ' today',
          drill: count + ' ' + unitN + ' logged'
        });
      sub = left === 1
        ? 'One more to hit your goal of ' + goal + '.'
        : left + ' more to hit your goal of ' + goal + '.';
    }
    return { title, sub };
  }

  // ----- Streak line --------------------------------------------------------

  function streak(opts) {
    const o = opts || {};
    const days = int(o.days);
    const voice = voiceOf(o.voice);
    if (o.restToday) {
      return days > 0
        ? 'Rest day. Your ' + days + '-day streak is safe.'
        : 'Rest day. Recharge and come back fresh.';
    }
    if (o.freezeUsed && days > 0) {
      return 'A streak freeze covered a missed day. Day ' + days + ', still going.';
    }
    if (days === 0) {
      return pick(voice, {
        gentle: 'Fresh start today',
        coach: 'Fresh start today',
        drill: 'Fresh start today. Make it count.'
      });
    }
    if (days === 1) {
      return pick(voice, {
        gentle: 'Day 1. A lovely start.',
        coach: 'Day 1. Good start.',
        drill: 'Day 1. Now do it again tomorrow.'
      });
    }
    if (days >= 30) return 'Day ' + days + '. This is a real habit now.';
    if (days >= 7) {
      return pick(voice, {
        gentle: 'Day ' + days + '. Look how far you have come.',
        coach: 'Day ' + days + '. You are locked in.',
        drill: 'Day ' + days + '. Hold the line.'
      });
    }
    return pick(voice, {
      gentle: 'Day ' + days + '. One day at a time.',
      coach: 'Day ' + days + '. Keep it rolling.',
      drill: 'Day ' + days + '. Keep moving.'
    });
  }

  // ----- Milestones ---------------------------------------------------------

  const MILESTONE_BODIES = {
    1: 'Starting is the hardest part, and you just did it.',
    10: 'Ten in. You have a rhythm now.',
    25: 'Twenty-five is real momentum. Most people stop well before this.',
    50: 'Most offers take dozens; you\'re on your way.',
    100: 'A hundred. That is serious, steady work.',
    250: 'Two hundred fifty. Your persistence is rare.',
    500: 'Five hundred. Few people ever put in this much effort.',
    1000: 'One thousand. That is a body of work to be proud of.'
  };

  function milestone(count, unit) {
    const n = int(count);
    const u = unitFor(unit, n);
    if (n === 1) {
      return { title: 'Your first ' + u + ' is in', body: MILESTONE_BODIES[1] };
    }
    return {
      title: n + ' ' + u,
      body: MILESTONE_BODIES[n] || 'Every one of these moves you closer. Keep going.'
    };
  }

  function firstInterview() {
    return {
      title: 'Your first interview',
      body: 'Someone read your application and wants to talk. The work is paying off.'
    };
  }

  // ----- Rejection ----------------------------------------------------------

  function rejection(voice) {
    return pick(voice, {
      gentle: 'That one stings. It says nothing about your worth, and you are still in it.',
      coach: 'Every no is a rep. You\'re still in it.',
      drill: 'A no is part of the process. Log it and send the next one.'
    });
  }

  // ----- Daily reminder -----------------------------------------------------

  function reminder(opts) {
    const o = opts || {};
    const count = int(o.count);
    const goal = Math.max(1, int(o.goal) || 1);
    const voice = voiceOf(o.voice);
    if (count >= goal) {
      return {
        title: 'Already locked in today',
        body: 'You hit your goal of ' + goal + '. Anything more is a bonus.'
      };
    }
    if (count > 0) {
      const left = goal - count;
      return {
        title: pick(voice, {
          gentle: 'You are partway there',
          coach: count + ' down, ' + left + ' to go',
          drill: left + ' left on today\'s goal'
        }),
        body: pick(voice, {
          gentle: 'Whenever you have a moment, ' + left + ' more will round out today.',
          coach: left === 1 ? 'One more and today is locked in.' : left + ' more and today is locked in.',
          drill: 'Block out a few minutes and close it out.'
        })
      };
    }
    return {
      title: pick(voice, {
        gentle: 'A gentle nudge',
        coach: 'Quick check-in',
        drill: 'Today\'s goal is waiting'
      }),
      body: pick(voice, {
        gentle: 'No pressure. Even one today keeps things moving.',
        coach: 'Your goal is ' + goal + ' today. Start with just one.',
        drill: 'Goal: ' + goal + '. Start the first one now.'
      })
    };
  }

  // ----- Weekly story -------------------------------------------------------

  const DAY_NAMES = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

  function dayName(bestDay) {
    if (!bestDay) return '';
    if (typeof bestDay === 'string') {
      if (/^\d{4}-\d{2}-\d{2}$/.test(bestDay)) {
        const p = bestDay.split('-').map(Number);
        return DAY_NAMES[new Date(p[0], p[1] - 1, p[2], 12).getDay()];
      }
      return bestDay;
    }
    if (typeof bestDay === 'object' && bestDay.date) return dayName(bestDay.date);
    return '';
  }

  // Never reports a decline. A quieter week gets credit for what was done.
  // Optional opts.unit ('applications', 'problems', ...) names what was done.
  function weekStory(opts) {
    const o = opts || {};
    const total = int(o.total);
    const active = int(o.activeDays);
    const last = int(o.lastWeekTotal);
    const best = o.bestDay;
    const bestCount = best && typeof best === 'object' ? int(best.count) : 0;
    const bestName = dayName(best);
    if (total === 0) {
      return 'A quiet week, and that is allowed. A fresh week starts whenever you do.';
    }
    const parts = [];
    const u = o.unit ? unitFor(o.unit, total) : '';
    const what = !u || u === 'applications' || u === 'application'
      ? 'You sent ' + total + (u ? ' ' + u : '')
      : 'You put in ' + total + ' ' + u;
    parts.push(what + ' this week' + (active > 0 ? ' across ' + active + (active === 1 ? ' day.' : ' days.') : '.'));
    if (bestName && bestCount > 1) parts.push(bestName + ' was your strongest day with ' + bestCount + '.');
    else if (bestName) parts.push(bestName + ' was your strongest day.');
    if (last > 0 && total > last) parts.push('That is ' + (total - last) + ' more than last week.');
    else if (active >= 5) parts.push('That kind of consistency is what gets results.');
    else parts.push('Every one of these is a real chance.');
    return parts.slice(0, 3).join(' ');
  }

  // ----- Empty states -------------------------------------------------------

  function empty(kind) {
    switch (kind) {
      case 'logs':
        return 'Nothing here yet. Press +1 or apply on a supported site and it shows up here.';
      case 'applications':
        return 'No applications sent yet. Your first one will appear here, ready to track.';
      case 'chart':
        return 'Your chart fills in as you go. One day of activity is enough to start.';
      case 'search':
        return 'No matches. Try a company name, a role, or a different spelling.';
      default:
        return 'Nothing here yet.';
    }
  }

  // ----- Daily tips ---------------------------------------------------------

  const tips = [
    'Press Alt+Shift+A on any page to add one to your current tracker without opening LIT.',
    'Press Alt+Shift+J to open LIT and search every application you have sent.',
    'Press Alt+Shift+F on an application form to fill it from your autofill profile.',
    'Open Google Calendar to see a small pill on each day showing what you did. A filled pill means you hit your goal.',
    'Missed logging a day? Hover over that day in Google Calendar and press + to add it.',
    'Drag any card in LIT to rearrange your board. Put what you check most at the top.',
    'Fill in your autofill profile once in Settings, and LIT can fill most application forms for you.',
    'LIT counts applications on Greenhouse, Lever, Ashby, and Workday by itself, the moment you submit.',
    'Pick rest days in Settings. They never break your streak, so taking a break is guilt-free.',
    'Hit your goal seven days in a row to earn a streak freeze. It covers a day you miss.',
    'Tap the goal number on the counter to change your daily goal. A smaller goal you keep beats a big one you dread.',
    'Heard back from a company? Mark that application as Interviewing or Offer to see your response rate.',
    'Use the + button to add a card, such as a weekly chart or a solve timer.',
    'Export a backup from Settings any time. Your data stays on your own devices.'
  ];

  // The same tip all day, a different one tomorrow.
  function tipFor(dateStr) {
    const s = typeof dateStr === 'string' ? dateStr : '';
    let h = 0;
    for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) >>> 0;
    return tips[h % tips.length];
  }

  // ----- Goal suggestion ----------------------------------------------------

  // After three missed days in a row, suggest a smaller goal instead of
  // repeating the big one. Returns null when there is nothing to suggest.
  function gentleGoal(opts) {
    const o = opts || {};
    const missed = int(o.missedDays);
    const goal = int(o.goal);
    if (missed < 3 || goal <= 1) return null;
    const smaller = Math.max(1, Math.ceil(goal / 2));
    return 'Tough stretch? Try a goal of ' + smaller + ' for a few days. Small wins rebuild momentum, and you can raise it any time.';
  }

  return {
    VOICES,
    headline,
    toast,
    streak,
    milestone,
    firstInterview,
    rejection,
    reminder,
    weekStory,
    empty,
    tips,
    tipFor,
    gentleGoal,
    unitFor
  };
})();

if (typeof self !== 'undefined' && self && !self.LitCopy) self.LitCopy = LitCopy;
if (typeof module !== 'undefined' && module.exports) {
  module.exports = LitCopy;
}
