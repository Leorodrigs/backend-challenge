import { Migration } from '@mikro-orm/migrations';

export class Migration20260906090000_finite_money extends Migration {
  override async up(): Promise<void> {
    this.addSql(`alter table wallets add constraint wallets_finite_money_check check (balance_amount <> 'NaN'::numeric);`);
    this.addSql(`alter table wager_transactions add constraint wager_transactions_finite_money_check check (amount <> 'NaN'::numeric);`);
    this.addSql(`alter table wallet_ledger_entries add constraint wallet_ledger_entries_finite_money_check check (amount <> 'NaN'::numeric and balance_before <> 'NaN'::numeric and balance_after <> 'NaN'::numeric);`);
  }
  override async down(): Promise<void> {
    this.addSql('alter table wallet_ledger_entries drop constraint wallet_ledger_entries_finite_money_check;');
    this.addSql('alter table wager_transactions drop constraint wager_transactions_finite_money_check;');
    this.addSql('alter table wallets drop constraint wallets_finite_money_check;');
  }
}
