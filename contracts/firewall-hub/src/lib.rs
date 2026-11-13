//! Firewall Hub: the Agent Firewall for many owners in one contract.
//!
//! Every NEAR account can open one budget here. The owner signs the rules from
//! their own wallet; the agent gets a function-call key on the owner's account
//! that can call only `pay` on this contract, so `pay` always runs as the owner
//! (the predecessor) and always under the owner's rules. Funds are held here as
//! internal balances and paid out as NEP-141 transfers, so NEAR can verify them.
//! Checks run in the same order, with the same codes, as `agent-firewall` and
//! `src/policy.ts`.

use near_sdk::json_types::U128;
use near_sdk::store::LookupMap;
use near_sdk::{
    env, ext_contract, log, near, require, serde_json, AccountId, Gas, NearToken, PanicOnDefault,
    Promise, PromiseError, PromiseOrValue,
};

const NANOS_PER_DAY: u64 = 86_400_000_000_000;
const MAX_MEMO_LEN: usize = 64;
const MAX_PAYEES: usize = 16;
const FT_TRANSFER_GAS: Gas = Gas::from_tgas(15);
const ON_PAY_GAS: Gas = Gas::from_tgas(10);

#[ext_contract(ext_ft)]
#[allow(dead_code)]
trait FungibleToken {
    fn ft_transfer(&mut self, receiver_id: AccountId, amount: U128, memo: Option<String>);
}

#[near(serializers = [borsh])]
pub struct Vault {
    per_tx_max: u128,
    daily_max: u128,
    allowlist: Vec<AccountId>,
    paused: bool,
    day: u64,
    spent_today: u128,
    balance: u128,
    faucet_day: u64,
}

#[near(serializers = [json])]
pub struct VaultView {
    pub per_tx_max: U128,
    pub daily_max: U128,
    pub allowlist: Vec<AccountId>,
    pub paused: bool,
    pub spent_today: U128,
    pub remaining_today: U128,
    pub balance: U128,
    pub faucet_ready: bool,
}

#[near(serializers = [json])]
pub struct HubInfo {
    pub token: AccountId,
    pub reserve: U128,
    pub faucet_amount: U128,
}

#[near(contract_state)]
#[derive(PanicOnDefault)]
pub struct FirewallHub {
    admin: AccountId,
    token: AccountId,
    vaults: LookupMap<AccountId, Vault>,
    /// Test tokens the faucet hands out, topped up with ft_transfer_call(msg = "reserve").
    reserve: u128,
    faucet_amount: u128,
}

#[near]
impl FirewallHub {
    #[init]
    pub fn new(admin: AccountId, token: AccountId, faucet_amount: U128) -> Self {
        Self {
            admin,
            token,
            vaults: LookupMap::new(b"v"),
            reserve: 0,
            faucet_amount: faucet_amount.0,
        }
    }

    /// Opens a budget for the caller and gives it one faucet payout.
    pub fn create_vault(&mut self, per_tx_max: U128, daily_max: U128, allowlist: Vec<AccountId>) -> VaultView {
        let owner = env::predecessor_account_id();
        require!(!self.vaults.contains_key(&owner), "ERR_VAULT_EXISTS");
        require!(allowlist.len() <= MAX_PAYEES, "ERR_TOO_MANY_PAYEES");
        let mut vault = Vault {
            per_tx_max: per_tx_max.0,
            daily_max: daily_max.0,
            allowlist,
            paused: false,
            day: today(),
            spent_today: 0,
            balance: 0,
            faucet_day: u64::MAX,
        };
        self.drip(&mut vault);
        let view = view_of(&vault);
        self.vaults.insert(owner, vault);
        view
    }

    /// Test tokens for the caller's budget, once per day while the reserve lasts.
    pub fn faucet(&mut self) -> U128 {
        let owner = env::predecessor_account_id();
        let mut vault = self.vaults.remove(&owner).unwrap_or_else(|| env::panic_str("ERR_NO_VAULT"));
        require!(vault.faucet_day != today(), "ERR_FAUCET_USED_TODAY");
        let paid = self.drip(&mut vault);
        self.vaults.insert(owner, vault);
        U128(paid)
    }

    /// Called by the agent through its function-call key on the owner's account.
    pub fn pay(&mut self, payee: AccountId, amount: U128, memo: String) -> Promise {
        let owner = env::predecessor_account_id();
        let amount = amount.0;
        let vault = self.vaults.get_mut(&owner).unwrap_or_else(|| env::panic_str("ERR_NO_VAULT"));
        require!(!vault.paused, "ERR_PAUSED");
        require!(amount > 0, "ERR_ZERO");
        require!(amount <= vault.per_tx_max, "ERR_PER_TX_LIMIT");
        require!(vault.allowlist.contains(&payee), "ERR_PAYEE_NOT_ALLOWED");
        require!(memo.len() <= MAX_MEMO_LEN, "ERR_MEMO_TOO_LONG");
        roll_day(vault);
        require!(vault.spent_today + amount <= vault.daily_max, "ERR_DAILY_LIMIT");
        require!(amount <= vault.balance, "ERR_BALANCE");

        // Take the money and count the spend now; on_pay gives both back if the transfer fails.
        vault.spent_today += amount;
        vault.balance -= amount;
        let day = vault.day;
        ext_ft::ext(self.token.clone())
            .with_attached_deposit(NearToken::from_yoctonear(1))
            .with_static_gas(FT_TRANSFER_GAS)
            .ft_transfer(payee.clone(), U128(amount), Some(memo.clone()))
            .then(
                Self::ext(env::current_account_id())
                    .with_static_gas(ON_PAY_GAS)
                    .on_pay(owner, payee, U128(amount), memo, day),
            )
    }

    #[private]
    pub fn on_pay(
        &mut self,
        #[callback_result] result: Result<(), PromiseError>,
        owner: AccountId,
        payee: AccountId,
        amount: U128,
        memo: String,
        day: u64,
    ) -> bool {
        let ok = result.is_ok();
        if !ok {
            if let Some(vault) = self.vaults.get_mut(&owner) {
                vault.balance += amount.0;
                if vault.day == day {
                    vault.spent_today = vault.spent_today.saturating_sub(amount.0);
                }
            }
        }
        let event = serde_json::json!({
            "standard": "agentfw",
            "version": "1.0.0",
            "event": if ok { "pay" } else { "pay_failed" },
            "data": [{ "owner": owner, "payee": payee, "amount": amount, "memo": memo }],
        });
        log!("EVENT_JSON:{}", event);
        ok
    }

    // ---------- owner: each call changes the caller's own budget ----------

    pub fn set_limits(&mut self, per_tx_max: U128, daily_max: U128) {
        let vault = self.own_vault();
        vault.per_tx_max = per_tx_max.0;
        vault.daily_max = daily_max.0;
    }

    pub fn add_payee(&mut self, payee: AccountId) {
        let vault = self.own_vault();
        if !vault.allowlist.contains(&payee) {
            require!(vault.allowlist.len() < MAX_PAYEES, "ERR_TOO_MANY_PAYEES");
            vault.allowlist.push(payee);
        }
    }

    pub fn remove_payee(&mut self, payee: AccountId) {
        self.own_vault().allowlist.retain(|a| a != &payee);
    }

    pub fn set_paused(&mut self, paused: bool) {
        self.own_vault().paused = paused;
    }

    /// Starts a new spending day early. Handy for demos; the day also rolls over at midnight UTC.
    pub fn reset_day(&mut self) {
        let vault = self.own_vault();
        vault.day = today();
        vault.spent_today = 0;
    }

    // ---------- token ----------

    /// NEP-141 receiver. msg "reserve" funds the faucet; otherwise the tokens go to the
    /// budget named in msg (or the sender's). Unknown budgets get their tokens back.
    pub fn ft_on_transfer(&mut self, sender_id: AccountId, amount: U128, msg: String) -> PromiseOrValue<U128> {
        require!(env::predecessor_account_id() == self.token, "ERR_WRONG_TOKEN");
        if msg == "reserve" {
            self.reserve += amount.0;
            return PromiseOrValue::Value(U128(0));
        }
        let target: AccountId = if msg.is_empty() { sender_id } else { msg.parse().unwrap_or_else(|_| env::panic_str("ERR_BAD_MSG")) };
        match self.vaults.get_mut(&target) {
            Some(vault) => {
                vault.balance += amount.0;
                PromiseOrValue::Value(U128(0))
            }
            None => PromiseOrValue::Value(amount),
        }
    }

    // ---------- views ----------

    pub fn get_vault(&self, account_id: AccountId) -> Option<VaultView> {
        self.vaults.get(&account_id).map(view_of)
    }

    pub fn get_info(&self) -> HubInfo {
        HubInfo { token: self.token.clone(), reserve: U128(self.reserve), faucet_amount: U128(self.faucet_amount) }
    }
}

impl FirewallHub {
    fn own_vault(&mut self) -> &mut Vault {
        self.vaults
            .get_mut(&env::predecessor_account_id())
            .unwrap_or_else(|| env::panic_str("ERR_NO_VAULT"))
    }

    fn drip(&mut self, vault: &mut Vault) -> u128 {
        let paid = self.faucet_amount.min(self.reserve);
        self.reserve -= paid;
        vault.balance += paid;
        vault.faucet_day = today();
        paid
    }
}

fn today() -> u64 {
    env::block_timestamp() / NANOS_PER_DAY
}

fn roll_day(vault: &mut Vault) {
    let day = today();
    if day != vault.day {
        vault.day = day;
        vault.spent_today = 0;
    }
}

fn view_of(v: &Vault) -> VaultView {
    let spent = if v.day == today() { v.spent_today } else { 0 };
    VaultView {
        per_tx_max: U128(v.per_tx_max),
        daily_max: U128(v.daily_max),
        allowlist: v.allowlist.clone(),
        paused: v.paused,
        spent_today: U128(spent),
        remaining_today: U128(v.daily_max.saturating_sub(spent)),
        balance: U128(v.balance),
        faucet_ready: v.faucet_day != today(),
    }
}

#[cfg(test)]
#[allow(unused_must_use)]
mod tests {
    use super::*;
    use near_sdk::test_utils::VMContextBuilder;
    use near_sdk::testing_env;

    fn hub() -> AccountId {
        "hub.testnet".parse().unwrap()
    }
    fn token() -> AccountId {
        "usdc.testnet".parse().unwrap()
    }
    fn alice() -> AccountId {
        "alice.testnet".parse().unwrap()
    }
    fn api() -> AccountId {
        "weather-api.testnet".parse().unwrap()
    }

    fn call_as(who: AccountId) {
        testing_env!(VMContextBuilder::new().current_account_id(hub()).predecessor_account_id(who).build());
    }

    /// A hub with 1,000,000 units in reserve and a 500,000 faucet; alice has a budget.
    fn setup() -> FirewallHub {
        call_as(alice());
        let mut c = FirewallHub::new(alice(), token(), U128(500_000));
        call_as(token());
        c.ft_on_transfer(alice(), U128(1_000_000), "reserve".into());
        call_as(alice());
        c.create_vault(U128(100_000), U128(200_000), vec![api()]);
        c
    }

    #[test]
    fn new_budget_gets_faucet_payout() {
        let c = setup();
        let v = c.get_vault(alice()).unwrap();
        assert_eq!(v.balance.0, 500_000);
        assert!(!v.faucet_ready);
        assert_eq!(c.get_info().reserve.0, 500_000);
    }

    #[test]
    fn pays_within_limits() {
        let mut c = setup();
        c.pay(api(), U128(10_000), "nonce".into());
        let v = c.get_vault(alice()).unwrap();
        assert_eq!(v.spent_today.0, 10_000);
        assert_eq!(v.balance.0, 490_000);
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
    #[should_panic(expected = "ERR_BALANCE")]
    fn blocks_over_balance() {
        let mut c = setup();
        c.set_limits(U128(10_000_000), U128(10_000_000));
        c.pay(api(), U128(500_001), "".into());
    }

    #[test]
    #[should_panic(expected = "ERR_PAUSED")]
    fn owner_can_pause() {
        let mut c = setup();
        c.set_paused(true);
        c.pay(api(), U128(1), "".into());
    }

    #[test]
    #[should_panic(expected = "ERR_NO_VAULT")]
    fn others_cannot_spend_alices_budget() {
        let mut c = setup();
        call_as("mallory.testnet".parse().unwrap());
        c.pay(api(), U128(1), "".into());
    }

    #[test]
    fn owner_rules_apply_only_to_own_budget() {
        let mut c = setup();
        call_as("bob.testnet".parse().unwrap());
        c.create_vault(U128(1), U128(1), vec![]);
        c.set_paused(true);
        assert!(!c.get_vault(alice()).unwrap().paused);
    }

    #[test]
    fn failed_transfer_refunds_balance_and_budget() {
        let mut c = setup();
        c.pay(api(), U128(50_000), "".into());
        let day = today();
        c.on_pay(Err(PromiseError::Failed), alice(), api(), U128(50_000), "".into(), day);
        let v = c.get_vault(alice()).unwrap();
        assert_eq!(v.spent_today.0, 0);
        assert_eq!(v.balance.0, 500_000);
    }

    #[test]
    #[should_panic(expected = "ERR_FAUCET_USED_TODAY")]
    fn faucet_once_per_day() {
        let mut c = setup();
        c.faucet();
    }

    #[test]
    fn deposit_to_unknown_budget_is_refunded() {
        let mut c = setup();
        call_as(token());
        let back = c.ft_on_transfer(alice(), U128(7), "nobody.testnet".into());
        assert!(matches!(back, PromiseOrValue::Value(U128(7))));
    }

    #[test]
    #[should_panic(expected = "ERR_WRONG_TOKEN")]
    fn rejects_other_tokens() {
        let mut c = setup();
        call_as("fake-usdc.testnet".parse().unwrap());
        c.ft_on_transfer(alice(), U128(1_000_000), "reserve".into());
    }
}
