import type { FactorScore } from '../../types'
import { useECharts } from './useECharts'
import type * as echarts from 'echarts'

interface Props {
  factorScores: FactorScore[]
  height?: number
}

/** 因子得分雷达图 */
export default function RadarChart({ factorScores, height = 280 }: Props) {
  if (!factorScores || factorScores.length === 0) {
    return (
      <div className="radar-empty" style={{ height, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
        <span className="muted">暂无因子数据</span>
      </div>
    )
  }

  const indicators = factorScores.map((f) => ({
    name: f.name,
    max: 100,
  }))
  const values = factorScores.map((f) => f.score)

  const option: echarts.EChartsOption = {
    animation: false,
    tooltip: {},
    radar: {
      indicator: indicators,
      radius: '65%',
      splitArea: { areaStyle: { color: ['#fafafa', '#f0f0f0'] } },
      axisName: { color: '#333', fontSize: 11 },
    },
    series: [
      {
        type: 'radar',
        data: [
          {
            value: values,
            name: '因子得分',
            areaStyle: { color: 'rgba(25,113,194,0.25)' },
            lineStyle: { color: '#1971c2', width: 2 },
            itemStyle: { color: '#1971c2' },
          },
        ],
      },
    ],
  }

  const ref = useECharts(option, [factorScores])
  return <div ref={ref} style={{ width: '100%', height }} />
}
