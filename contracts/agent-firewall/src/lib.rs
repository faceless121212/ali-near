//! Agent Firewall: a vault contract that an AI agent can spend from only within
//! limits set by its human owner.
//!
//! Deploy it to the vault account (e.g. `marketing.acme.testnet`).
//! The agent gets a function-call access key on that account restricted to `pay`,
//! so its only possible action is `pay`, and `pay` enforces the policy.
//! Error codes match `src/policy.ts`.

use near_sdk::json_types::U128;
use near_sdk::store::IterableSet;
use near_sdk::{
    assert_one_yocto, env, ext_contract, log, near, require, serde_json, AccountId, Gas, NearToken,
    PanicOnDefault, Promise, PromiseError,
};

const NANOS_PER_DAY: u64 = 86_400_000_000_000;
const MAX_MEMO_LEN: usize = 64;
const FT_TRANSFER_GAS: Gas = Gas::from_tgas(15);
const ON_PAY_GAS: Gas = Gas::from_tgas(10);

#[ext_contract(ext_ft)]
#[allow(dead_code)]
trait FungibleToken {
    fn ft_transfer(&mut self, receiver_id: AccountId, amount: U128, memo: Option<String>);
}

#[near(contract_state)]
#[derive(PanicOnDefault)]
pub struct AgentFirewall {
    owner: AccountId,
    token: AccountId,
    per_tx_max: u128,
    daily_max: u128,
    allowlist: IterableSet<AccountId>,
    paused: bool,
    day: u64,
    spent_today: u128,
}

#[near(serializers = [json])]
pub struct PolicyView {
    pub owner: AccountId,
    pub token: AccountId,
    pub per_tx_max: U128,
    pub daily_max: U128,
    pub allowlist: Vec<AccountId>,
    pub paused: bool,
    pub spent_today: U128,
    pub remaining_today: U128,
}

#[near]
impl AgentFirewall {
    #[init]
    pub fn new(
        owner: AccountId,
        token: AccountId,
        per_tx_max: U128,
        daily_max: U128,
        allowlist: Vec<AccountId>,
    ) -> Self {
        let mut set = IterableSet::new(b"a");
        for account in allowlist {
            set.insert(account);
        }
        Self {
            owner,
            token,
            per_tx_max: per_tx_max.0,
            daily_max: daily_max.0,
            allowlist: set,
            paused: false,
            day: today(),
            spent_today: 0,
        }
    }

    /// Called by the agent through its function-call key on this account.
    pub fn pay(&mut self, payee: AccountId, amount: U128, memo: String) -> Promise {
        require!(
            env::predecessor_account_id() == env::current_account_id(),
            "ERR_NOT_AGENT"
        );
        let amount = amount.0;
        require!(!self.paused, "ERR_PAUSED");
        require!(amount > 0, "ERR_ZERO");
        require!(amount <= self.per_tx_max, "ERR_PER_TX_LIMIT");
        require!(self.allowlist.contains(&payee), "ERR_PAYEE_NOT_ALLOWED");
        require!(memo.len() <= MAX_MEMO_LEN, "ERR_MEMO_TOO_LONG");
        self.roll_day();
        require!(
            self.spent_today + amount <= self.daily_max,
            "ERR_DAILY_LIMIT"
        );

        // Count the spend now so parallel calls can't exceed the cap; on_pay refunds it on failure.
        self.spent_today += amount;
        ext_ft::ext(self.token.clone())
            .with_attached_deposit(NearToken::from_yoctonear(1))
            .with_static_gas(FT_TRANSFER_GAS)
            .ft_transfer(payee.clone(), U128(amount), Some(memo.clone()))
            .then(
                Self::ext(env::current_account_id())
                    .with_static_gas(ON_PAY_GAS)
                    .on_pay(payee, U128(amount), memo, self.day),
            )
    }

    #[private]
    pub fn on_pay(
        &mut self,
        #[callback_result] result: Result<(), PromiseError>,
        payee: AccountId,
        amount: U128,
        memo: String,
        day: u64,
    ) -> bool {
        let ok = result.is_ok();
        if !ok && self.day == day {
            self.spent_today = self.spent_today.saturating_sub(amount.0);
        }
        let event = serde_json::json!({
            "standard": "agentfw",
            "version": "1.0.0",
            "event": if ok { "pay" } else { "pay_failed" },
            "data": [{ "payee": payee, "amount": amount, "memo": memo }],
        });
        log!("EVENT_JSON:{}", event);
        ok
    }

    // ---------- owner ----------

    pub fn set_limits(&mut self, per_tx_max: U128, daily_max: U128) {
        self.assert_owner();
        self.per_tx_max = per_tx_max.0;
        self.daily_max = daily_max.0;
    }

    pub fn add_payee(&mut self, payee: AccountId) {
        self.assert_owner();
        self.allowlist.insert(payee);
    }

    pub fn remove_payee(&mut self, payee: AccountId) {
        self.assert_owner();
        self.allowlist.remove(&payee);
    }

    pub fn set_paused(&mut self, paused: bool) {
        self.assert_owner();
        self.paused = paused;
    }

    /// Starts a new spending day early. Handy for demos; the day also rolls over at midnight UTC.
    pub fn reset_day(&mut self) {
        self.assert_owner();
        self.day = today();
        self.spent_today = 0;
    }

    /// Sends tokens back to the owner. Requires 1 yoctoNEAR, so a function-call key can't call it.
    #[payable]
    pub fn withdraw(&mut self, amount: U128) -> Promise {
        assert_one_yocto();
        self.assert_owner();
        ext_ft::ext(self.token.clone())
            .with_attached_deposit(NearToken::from_yoctonear(1))
            .with_static_gas(FT_TRANSFER_GAS)
            .ft_transfer(self.owner.clone(), amount, Some("agent-firewall withdraw".into()))
    }

    // ---------- views ----------

    pub fn get_policy(&self) -> PolicyView {
        let spent = if self.day == today() { self.spent_today } else { 0 };
        PolicyView {
            owner: self.owner.clone(),
            token: self.token.clone(),
            per_tx_max: U128(self.per_tx_max),
            daily_max: U128(self.daily_max),
            allowlist: self.allowlist.iter().cloned().collect(),
            paused: self.paused,
            spent_today: U128(spent),
            remaining_today: U128(self.daily_max.saturating_sub(spent)),
        }
    }
}

impl AgentFirewall {
    fn assert_owner(&self) {
        require!(env::predecessor_account_id() == self.owner, "ERR_NOT_OWNER");
    }

    fn roll_day(&mut self) {
        let day = today();
        if day != self.day {
            self.day = day;
            self.spent_today = 0;
        }
    }
}

fn today() -> u64 {
    env::block_timestamp() / NANOS_PER_DAY
}

#[cfg(test)]
mod tests {
    use super::*;
    use near_sdk::test_utils::VMContextBuilder;
    use near_sdk::testing_env;

    fn vault() -> AccountId {
        "bot.agents.alice.testnet".parse().unwrap()
    }
    fn owner() -> AccountId {
        "alice.testnet".parse().unwrap()
    }
    fn api() -> AccountId {
        "weather-api.testnet".parse().unwrap()
    }

    fn as_agent() {
        testing_env!(VMContextBuilder::new()
            .current_account_id(vault())
            .predecessor_account_id(vault())
            .build());
    }

    fn setup() -> AgentFirewall {
        as_agent();
        AgentFirewall::new(
            owner(),
            "usdc.testnet".parse().unwrap(),
            U128(100_000),
            U128(200_000),
            vec![api()],
        )
    }

    #[test]
    fn pays_within_limits() {
        let mut c = setup();
        c.pay(api(), U128(10_000), "nonce".into());
        assert_eq!(c.get_policy().spent_today.0, 10_000);
        assert_eq!(c.get_policy().remaining_today.0, 190_000);
    }

    #[test]
    #[should_panic(expected = "ERR_PAYEE_NOT_ALLOWED")]
    fn blocks_unknown_payee() {
        let mut c = setup();
        c.pay("drainer.testnet".parse().unwrap(), U128(1), "".into());
    }

    #[test]
    #[should_panic(expected = "ERR_PER_TX_LIMIT")]
    fn blocks_large_payment() {
        let mut c = setup();
        c.pay(api(), U128(100_001), "".into());
    }

    #[test]
    #[should_panic(expected = "ERR_DAILY_LIMIT")]
    fn blocks_over_daily_cap() {
        let mut c = setup();
        c.pay(api(), U128(100_000), "".into());
        c.pay(api(), U128(100_000), "".into());
        c.pay(api(), U128(1), "".into());
    }

    #[test]
    #[should_panic(expected = "ERR_NOT_AGENT")]
    fn only_vault_key_can_pay() {
        let mut c = setup();
        testing_env!(VMContextBuilder::new()
            .current_account_id(vault())
            .predecessor_account_id(owner())
            .build());
        c.pay(api(), U128(1), "".into());
    }

    #[test]
    #[should_panic(expected = "ERR_PAUSED")]
    fn owner_can_pause() {
        let mut c = setup();
        testing_env!(VMContextBuilder::new()
            .current_account_id(vault())
            .predecessor_account_id(owner())
            .build());
        c.set_paused(true);
        as_agent();
        c.pay(api(), U128(1), "".into());
    }

    #[test]
    #[should_panic(expected = "ERR_NOT_OWNER")]
    fn agent_cannot_change_limits() {
        let mut c = setup();
        c.set_limits(U128(u128::MAX), U128(u128::MAX));
    }

    #[test]
    fn failed_transfer_refunds_budget() {
        let mut c = setup();
        c.pay(api(), U128(50_000), "".into());
        let day = c.day;
        c.on_pay(Err(PromiseError::Failed), api(), U128(50_000), "".into(), day);
        assert_eq!(c.get_policy().spent_today.0, 0);
    }

    #[test]
    fn budget_resets_next_day() {
        let mut c = setup();
        c.pay(api(), U128(100_000), "".into());
        c.pay(api(), U128(100_000), "".into());
        testing_env!(VMContextBuilder::new()
            .current_account_id(vault())
            .predecessor_account_id(vault())
            .block_timestamp(NANOS_PER_DAY * 2)
            .build());
        c.pay(api(), U128(100_000), "".into());
        assert_eq!(c.get_policy().spent_today.0, 100_000);
    }
}
