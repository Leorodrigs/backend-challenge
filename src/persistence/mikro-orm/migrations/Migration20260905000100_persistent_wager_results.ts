import { Migration } from '@mikro-orm/migrations';

export class Migration20260905000100_persistent_wager_results extends Migration {
  override async up(): Promise<void> {
    this.addSql(`
      alter table wager_transactions
        add column result_balance_amount numeric(20,2) null,
        add column result_balance_currency varchar(3) null,
        add column result_wallet_version integer null,
        add constraint wager_transactions_result_all_or_none_check check (
          (result_balance_amount is null and result_balance_currency is null and result_wallet_version is null) or
          (result_balance_amount is not null and result_balance_currency is not null and result_wallet_version is not null)
        ),
        add constraint wager_transactions_result_balance_check check (result_balance_amount >= 0 and result_balance_amount <> 'NaN'::numeric),
        add constraint wager_transactions_result_currency_check check (result_balance_currency ~ '^[A-Z]{3}$'),
        add constraint wager_transactions_result_version_check check (result_wallet_version >= 1);
    `);
    this.addSql('alter table wager_transactions alter constraint wager_transactions_wallet_fk deferrable initially immediate;');
  }

  override async down(): Promise<void> {
    this.addSql('alter table wager_transactions alter constraint wager_transactions_wallet_fk not deferrable;');
    this.addSql(`
      alter table wager_transactions
        drop constraint wager_transactions_result_all_or_none_check,
        drop constraint wager_transactions_result_balance_check,
        drop constraint wager_transactions_result_currency_check,
        drop constraint wager_transactions_result_version_check,
        drop column result_balance_amount,
        drop column result_balance_currency,
        drop column result_wallet_version;
    `);
  }
}
