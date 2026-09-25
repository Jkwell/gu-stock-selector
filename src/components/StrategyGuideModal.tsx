import { STRATEGY_TEMPLATES, DEFAULT_FACTORS } from '../config/factors'

interface Props {
  onClose: () => void
}

/** 按分组显示因子名 */
const factorName = new Map(DEFAULT_FACTORS.map((f) => [f.key, f.name]))
const factorGroup = new Map(DEFAULT_FACTORS.map((f) => [f.key, f.group]))

const GROUP_LABELS: Record<string, string> = {
  technical: '📊 技术面（看价格和成交）',
  fundamental: '🏢 基本面（看公司好不好）',
  money: '💰 资金面（看大资金）',
}

/** 策略说明弹窗：策略模板 + 因子 + 买卖点 */
export default function StrategyGuideModal({ onClose }: Props) {
  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal guide-modal" onClick={(e) => e.stopPropagation()}>
        <div className="modal-header">
          <h2>📖 策略与因子说明</h2>
          <button className="modal-close" onClick={onClose}>
            ✕
          </button>
        </div>

        <div className="modal-body guide-body">
          {/* 策略模板 */}
          <h3 className="guide-section-title">🎯 策略模板怎么选</h3>
          <p className="guide-tip">
            按风险从低到高排：温和放量（低）→ 均衡/价值/成长（低-中）→ 动量/题材龙头（中高）→ 强势领涨（高）。
            新手建议从「温和放量」开始。
          </p>
          {STRATEGY_TEMPLATES.map((t) => {
            const weights = Object.entries(t.weights)
              .filter(([, w]) => w > 0)
              .sort((a, b) => b[1] - a[1])
            return (
              <div key={t.key} className="guide-strategy">
                <div className="guide-strategy-head">
                  <span className="guide-strategy-name">{t.name}</span>
                  <span className="guide-strategy-pool">
                    池：{t.pool === 'all' ? '全部A股' : t.pool === 'hs300' ? '沪深300' : '中证500'}
                  </span>
                </div>
                <p className="guide-strategy-desc">{t.desc}</p>
                {/* 权重构成 */}
                <div className="guide-weights">
                  {weights.slice(0, 5).map(([key, w]) => (
                    <div key={key} className="guide-weight-row">
                      <span className="guide-weight-name">
                        {factorName.get(key) ?? key}
                        <span className="guide-weight-group">
                          {factorGroup.get(key) === 'technical' ? '技术' : factorGroup.get(key) === 'fundamental' ? '基本' : '资金'}
                        </span>
                      </span>
                      <div className="guide-weight-bar-wrap">
                        <div
                          className="guide-weight-bar"
                          style={{ width: `${Math.round(w * 200)}%` }}
                        />
                      </div>
                      <span className="guide-weight-val">{Math.round(w * 100)}%</span>
                    </div>
                  ))}
                </div>
              </div>
            )
          })}

          {/* 因子解释 */}
          <h3 className="guide-section-title">🧩 因子是什么意思</h3>
          {(['technical', 'fundamental', 'money'] as const).map((g) => (
            <div key={g}>
              <h4 className="guide-group-label">{GROUP_LABELS[g]}</h4>
              <table className="guide-table">
                <tbody>
                  {DEFAULT_FACTORS.filter((f) => f.group === g).map((f) => (
                    <tr key={f.key}>
                      <td className="guide-factor-name">{f.name}</td>
                      <td className="guide-factor-desc">{f.desc}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ))}

          {/* 买卖点说明 */}
          <h3 className="guide-section-title">🎯 买卖点怎么读</h3>
          <div className="guide-targets">
            <div className="target target-buy">
              <span className="target-label">买入区间</span>
              <span className="guide-target-desc">支撑位 ~ 现价之间，跌到这里分批买入，越接近支撑越划算；价格高于区间别追</span>
            </div>
            <div className="target target-profit">
              <span className="target-label">止盈目标</span>
              <span className="guide-target-desc">参考前期高点和 +5%，涨到这里卖出落袋</span>
            </div>
            <div className="target target-stop">
              <span className="target-label">止损价</span>
              <span className="guide-target-desc">约 -8%，跌破坚决离场，控制单票最大亏损</span>
            </div>
          </div>

          <div className="guide-warning">
            ⚠️ 涨停板追高风险极大。龙头/题材策略选出的涨停股是用来"看方向"的，建议等回调到支撑位再低吸，不要追涨停当天买。情绪冰点（🧊）时建议空仓。
          </div>
        </div>
      </div>
    </div>
  )
}
