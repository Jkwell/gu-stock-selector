/**
 * 仓位建议：把情绪温度换算成具体仓位
 * 🔥 火热(≥70) → 8成仓
 * 😐 中性(40-70) → 5成仓
 * 🧊 冰点(<40) → 2成仓（跟踪为主）
 */

export interface PositionAdvice {
  temperature: number
  level: 'hot' | 'neutral' | 'cold'
  position: number // 建议仓位 0-100%
  text: string
}

export function positionAdvice(temperature: number): PositionAdvice {
  if (temperature >= 70) {
    return {
      temperature,
      level: 'hot',
      position: 80,
      text: '情绪火热，可积极操作（建议 8 成仓）',
    }
  }
  if (temperature >= 40) {
    return {
      temperature,
      level: 'neutral',
      position: 50,
      text: '情绪一般，半仓谨慎参与（建议 5 成仓）',
    }
  }
  return {
    temperature,
    level: 'cold',
    position: 20,
    text: '情绪偏弱，轻仓跟踪（建议 2 成仓）',
  }
}
