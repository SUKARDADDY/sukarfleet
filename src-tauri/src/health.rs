//! Pure tray-state engine: classification + debounce + resume grace.
//! Clock-injected (now/wall passed in) so every transition is unit-testable,
//! same discipline as the daemon's health.ts.

use std::time::{Duration, Instant, SystemTime};

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum TrayState {
    Unknown,
    Unreachable,
    Setup,
    Critical,
    Degraded,
    Ok,
}

/// Severity rank for escalation logic. Setup sits outside the ladder (mode, not severity).
fn rank(s: TrayState) -> u8 {
    match s {
        TrayState::Ok => 0,
        TrayState::Degraded => 1,
        TrayState::Critical => 2,
        TrayState::Unreachable => 3,
        TrayState::Unknown | TrayState::Setup => 0,
    }
}

#[derive(Debug, Clone)]
pub enum Observation {
    Failure,
    Up {
        setup_complete: bool,
        has_critical: bool,
        has_any_fault: bool,
        uptime_sec: Option<f64>,
    },
}

#[derive(Debug, Clone, Copy)]
pub struct EngineOutput {
    pub displayed: TrayState,
    pub in_grace: bool,
    /// Notifications must be suppressed this tick (grace, unreachable, or pre-seed).
    pub suppress_notifications: bool,
}

pub struct Engine {
    interval: Duration,
    displayed: TrayState,
    candidate: TrayState,
    candidate_streak: u32,
    fail_streak: u32,
    last_escalation: Option<Instant>,
    grace_until: Option<Instant>,
    last_tick: Option<(Instant, SystemTime)>,
    last_uptime: Option<f64>,
}

const GRACE: Duration = Duration::from_secs(90);
const WALL_DIVERGENCE_MAX: Duration = Duration::from_secs(30);
const DE_ESCALATION_COOLDOWN: Duration = Duration::from_secs(60);
const UNREACHABLE_AFTER: u32 = 3;

impl Engine {
    pub fn new(interval: Duration) -> Self {
        Self {
            interval,
            displayed: TrayState::Unknown,
            candidate: TrayState::Unknown,
            candidate_streak: 0,
            fail_streak: 0,
            last_escalation: None,
            grace_until: None,
            last_tick: None,
            last_uptime: None,
        }
    }

    pub fn observe(&mut self, obs: &Observation, now: Instant, wall: SystemTime) -> EngineOutput {
        self.detect_resume(&obs, now, wall);
        let in_grace = self.grace_until.map(|g| now < g).unwrap_or(false);

        let raw = match obs {
            Observation::Failure => {
                self.fail_streak += 1;
                if self.fail_streak >= UNREACHABLE_AFTER {
                    TrayState::Unreachable
                } else if self.displayed == TrayState::Unknown {
                    TrayState::Unknown
                } else {
                    self.displayed // brief blip: hold what we showed
                }
            }
            Observation::Up {
                setup_complete,
                has_critical,
                has_any_fault,
                ..
            } => {
                self.fail_streak = 0;
                if !setup_complete {
                    TrayState::Setup
                } else if *has_critical {
                    TrayState::Critical
                } else if *has_any_fault {
                    TrayState::Degraded
                } else {
                    TrayState::Ok
                }
            }
        };

        self.apply(raw, now, in_grace);

        let suppress = in_grace || matches!(self.displayed, TrayState::Unreachable | TrayState::Unknown);
        EngineOutput {
            displayed: self.displayed,
            in_grace,
            suppress_notifications: suppress,
        }
    }

    fn detect_resume(&mut self, obs: &Observation, now: Instant, wall: SystemTime) {
        if let Some((prev_now, prev_wall)) = self.last_tick {
            let mono = now.duration_since(prev_now);
            let wall_delta = wall.duration_since(prev_wall).unwrap_or(Duration::ZERO);
            let frozen = mono > self.interval * 3;
            let diverged = wall_delta
                .checked_sub(mono)
                .map(|d| d > WALL_DIVERGENCE_MAX)
                .unwrap_or(false);
            if frozen || diverged {
                self.grace_until = Some(now + GRACE);
            }
        }
        if let Observation::Up { uptime_sec: Some(u), .. } = obs {
            if let Some(prev) = self.last_uptime {
                if *u < prev {
                    // daemon restarted
                    self.grace_until = Some(now + GRACE);
                }
            }
            self.last_uptime = Some(*u);
        }
        self.last_tick = Some((now, wall));
    }

    fn apply(&mut self, raw: TrayState, now: Instant, in_grace: bool) {
        if raw == self.displayed {
            self.candidate = raw;
            self.candidate_streak = 0;
            return;
        }
        if raw == self.candidate {
            self.candidate_streak += 1;
        } else {
            self.candidate = raw;
            self.candidate_streak = 1;
        }

        // First-ever resolution and Setup-mode flips apply immediately (stable config states).
        if self.displayed == TrayState::Unknown
            || raw == TrayState::Setup
            || self.displayed == TrayState::Setup
        {
            self.promote(raw, now);
            return;
        }

        let escalating = rank(raw) > rank(self.displayed);
        if in_grace && escalating {
            return; // resume fallout is not a fault
        }
        if escalating {
            let hold = match raw {
                TrayState::Critical => 2,
                TrayState::Unreachable => 1, // fail_streak already gated 3 misses
                _ => 3,
            };
            if self.candidate_streak >= hold {
                self.promote(raw, now);
            }
        } else {
            let cooled = self
                .last_escalation
                .map(|t| now.duration_since(t) >= DE_ESCALATION_COOLDOWN)
                .unwrap_or(true);
            if self.candidate_streak >= 2 && cooled {
                self.promote(raw, now);
            }
        }
    }

    fn promote(&mut self, raw: TrayState, now: Instant) {
        if rank(raw) > rank(self.displayed) {
            self.last_escalation = Some(now);
        }
        self.displayed = raw;
        self.candidate = raw;
        self.candidate_streak = 0;
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const TICK: Duration = Duration::from_secs(10);

    fn up(has_critical: bool, has_any: bool) -> Observation {
        Observation::Up {
            setup_complete: true,
            has_critical,
            has_any_fault: has_any || has_critical,
            uptime_sec: Some(1000.0),
        }
    }

    struct Clock {
        now: Instant,
        wall: SystemTime,
    }
    impl Clock {
        fn new() -> Self {
            Self { now: Instant::now(), wall: SystemTime::now() }
        }
        fn tick(&mut self, d: Duration) -> (Instant, SystemTime) {
            self.now += d;
            self.wall += d;
            (self.now, self.wall)
        }
        /// Suspend: wall advances, monotonic does not (within a running process the
        /// engine only sees the NEXT tick arriving with diverged deltas).
        fn suspend(&mut self, d: Duration) {
            self.wall += d;
        }
    }

    #[test]
    fn first_poll_resolves_immediately() {
        let mut e = Engine::new(TICK);
        let mut c = Clock::new();
        let (n, w) = c.tick(TICK);
        let out = e.observe(&up(false, false), n, w);
        assert_eq!(out.displayed, TrayState::Ok);
    }

    #[test]
    fn critical_needs_two_ticks() {
        let mut e = Engine::new(TICK);
        let mut c = Clock::new();
        let (n, w) = c.tick(TICK);
        e.observe(&up(false, false), n, w);
        let (n, w) = c.tick(TICK);
        assert_eq!(e.observe(&up(true, true), n, w).displayed, TrayState::Ok, "one bad tick holds");
        let (n, w) = c.tick(TICK);
        assert_eq!(e.observe(&up(true, true), n, w).displayed, TrayState::Critical);
    }

    #[test]
    fn de_escalation_needs_dwell_and_cooldown() {
        let mut e = Engine::new(TICK);
        let mut c = Clock::new();
        let (n, w) = c.tick(TICK);
        e.observe(&up(false, false), n, w);
        for _ in 0..2 {
            let (n, w) = c.tick(TICK);
            e.observe(&up(true, true), n, w);
        }
        // now Critical; recovery within cooldown must NOT flip back yet
        for _ in 0..3 {
            let (n, w) = c.tick(TICK);
            assert_eq!(e.observe(&up(false, false), n, w).displayed, TrayState::Critical);
        }
        // past the 60s cooldown (ticks are 10s), streak ≥2 → green
        for _ in 0..3 {
            let (n, w) = c.tick(TICK);
            e.observe(&up(false, false), n, w);
        }
        let (n, w) = c.tick(TICK);
        assert_eq!(e.observe(&up(false, false), n, w).displayed, TrayState::Ok);
    }

    #[test]
    fn unreachable_after_three_failures() {
        let mut e = Engine::new(TICK);
        let mut c = Clock::new();
        let (n, w) = c.tick(TICK);
        e.observe(&up(false, false), n, w);
        for i in 0..3 {
            let (n, w) = c.tick(TICK);
            let out = e.observe(&Observation::Failure, n, w);
            if i < 2 {
                assert_eq!(out.displayed, TrayState::Ok, "blip {i} holds");
            } else {
                assert_eq!(out.displayed, TrayState::Unreachable);
                assert!(out.suppress_notifications);
            }
        }
    }

    #[test]
    fn suspend_grants_grace_and_blocks_escalation() {
        let mut e = Engine::new(TICK);
        let mut c = Clock::new();
        let (n, w) = c.tick(TICK);
        e.observe(&up(false, false), n, w);
        c.suspend(Duration::from_secs(3600)); // lid closed 1h: wall jumps, mono doesn't
        let (n, w) = c.tick(TICK);
        // post-resume tick reports the peer offline (critical) — must be held green + suppressed
        let out = e.observe(&up(true, true), n, w);
        assert!(out.in_grace);
        assert!(out.suppress_notifications);
        assert_eq!(out.displayed, TrayState::Ok);
        // grace expires (90s at 10s ticks) with the fault persisting → escalate normally
        let mut last = TrayState::Ok;
        for _ in 0..12 {
            let (n, w) = c.tick(TICK);
            last = e.observe(&up(true, true), n, w).displayed;
        }
        assert_eq!(last, TrayState::Critical, "real fault escalates after grace");
    }

    #[test]
    fn daemon_restart_grants_grace() {
        let mut e = Engine::new(TICK);
        let mut c = Clock::new();
        let (n, w) = c.tick(TICK);
        e.observe(
            &Observation::Up { setup_complete: true, has_critical: false, has_any_fault: false, uptime_sec: Some(5000.0) },
            n,
            w,
        );
        let (n, w) = c.tick(TICK);
        let out = e.observe(
            &Observation::Up { setup_complete: true, has_critical: true, has_any_fault: true, uptime_sec: Some(3.0) },
            n,
            w,
        );
        assert!(out.in_grace, "uptime decrease = restart = grace");
        assert_eq!(out.displayed, TrayState::Ok);
    }

    #[test]
    fn setup_mode_applies_immediately() {
        let mut e = Engine::new(TICK);
        let mut c = Clock::new();
        let (n, w) = c.tick(TICK);
        let out = e.observe(
            &Observation::Up { setup_complete: false, has_critical: true, has_any_fault: true, uptime_sec: Some(1.0) },
            n,
            w,
        );
        assert_eq!(out.displayed, TrayState::Setup, "setup outranks critical");
    }
}
