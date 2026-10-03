use anchor_lang::prelude::*;

#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, PartialEq, Eq, Debug, InitSpace)]
pub struct PolicyParams {
    pub autonomous_bps: u16,
    pub drawdown_bps: u16,
    pub max_slippage_bps: u16,
    pub vote_window_secs: u32,
}

/// A fund's risk policy. Seeds: `[b"policy", fund]`.
#[account]
#[derive(InitSpace)]
pub struct Policy {
    pub fund: Pubkey,
    pub params: PolicyParams,
    pub pending: PolicyParams,
    /// 0 = none.
    pub pending_eta: i64,
    pub bump: u8,
}

impl PolicyParams {
    /// Inside the protocol floor (see `constants`).
    pub fn within_floor(&self) -> bool {
        use crate::constants::*;
        self.autonomous_bps <= MAX_AUTONOMOUS_BPS
            && self.drawdown_bps <= MAX_DRAWDOWN_BPS
            && self.max_slippage_bps <= MAX_SLIPPAGE_BPS
            && (MIN_VOTE_WINDOW_SECS..=MAX_VOTE_WINDOW_SECS).contains(&self.vote_window_secs)
    }

    /// Stricter or equal to `cur` in every field: lower or equal bps, a longer
    /// or equal vote window.
    pub fn stricter_or_equal(&self, cur: &PolicyParams) -> bool {
        self.autonomous_bps <= cur.autonomous_bps
            && self.drawdown_bps <= cur.drawdown_bps
            && self.max_slippage_bps <= cur.max_slippage_bps
            && self.vote_window_secs >= cur.vote_window_secs
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const D: PolicyParams = PolicyParams {
        autonomous_bps: 1000,
        drawdown_bps: 3000,
        max_slippage_bps: 100,
        vote_window_secs: 1800,
    };

    #[test]
    fn stricter_is_lower_bps_longer_window() {
        assert!(D.stricter_or_equal(&D));
        let s = |a, d, m, v| PolicyParams {
            autonomous_bps: a,
            drawdown_bps: d,
            max_slippage_bps: m,
            vote_window_secs: v,
        };
        assert!(s(999, 3000, 100, 1800).stricter_or_equal(&D));
        assert!(s(1000, 3000, 100, 1801).stricter_or_equal(&D));
        assert!(!s(1001, 3000, 100, 1800).stricter_or_equal(&D));
        assert!(!s(1000, 3001, 100, 1800).stricter_or_equal(&D));
        assert!(!s(1000, 3000, 101, 1800).stricter_or_equal(&D));
        assert!(!s(0, 0, 0, 1799).stricter_or_equal(&D));
    }

    #[test]
    fn floor_bounds_are_inclusive() {
        assert!(D.within_floor());
        let edge = PolicyParams {
            autonomous_bps: 2500,
            drawdown_bps: 5000,
            max_slippage_bps: 500,
            vote_window_secs: 60,
        };
        assert!(edge.within_floor());
        assert!(PolicyParams {
            vote_window_secs: 604_800,
            ..edge
        }
        .within_floor());
        assert!(!PolicyParams {
            autonomous_bps: 2501,
            ..edge
        }
        .within_floor());
        assert!(!PolicyParams {
            drawdown_bps: 5001,
            ..edge
        }
        .within_floor());
        assert!(!PolicyParams {
            max_slippage_bps: 501,
            ..edge
        }
        .within_floor());
        assert!(!PolicyParams {
            vote_window_secs: 59,
            ..edge
        }
        .within_floor());
        assert!(!PolicyParams {
            vote_window_secs: 604_801,
            ..edge
        }
        .within_floor());
    }
}
