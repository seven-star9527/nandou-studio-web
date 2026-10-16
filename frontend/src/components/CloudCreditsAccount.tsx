import { accountBalanceLabel, formatCredits, isCreditAmount } from '../credit-contract';
import type { CloudAccount } from '../types';
import Icon from './Icon';

export default function CloudCreditsAccount({ account, loading, error, refresh }: { account: CloudAccount | null; loading: boolean; error: string; refresh: () => void }) {
  const detail = [
    'APIMart 可用积分取账户余额与令牌额度的较低值；令牌不限额时以账户为准。',
    account && isCreditAmount(account.account_credits) ? `账户：${formatCredits(account.account_credits)} 积分。` : '账户余额未知。',
    account?.token_unlimited ? '令牌不限额。' : account && isCreditAmount(account.token_credits) ? `令牌：${formatCredits(account.token_credits)} 积分。` : '令牌额度未知。',
    account?.checked_utc && Number.isFinite(Date.parse(account.checked_utc)) ? `读取时间：${new Date(account.checked_utc).toLocaleString('zh-CN')}。` : '',
    account?.state === 'partial' ? '余额信息尚不完整。' : '', account?.error ?? error,
  ].filter(Boolean).join(' ');
  return <div className={`account-credits ${account?.state === 'partial' ? 'account-partial' : ''}`} title={detail}>
    <span role="status" aria-live="polite"><Icon name="spark" size={14} /><span>{loading && !account ? '积分读取中' : accountBalanceLabel(account)}</span></span>
    <button className="icon-button" onClick={refresh} disabled={loading} aria-label="刷新可用积分" title="刷新可用积分"><Icon name="refresh" size={14} className={loading ? 'spinning' : ''} /></button>
  </div>;
}
