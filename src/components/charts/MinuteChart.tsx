import type { MinutePoint } from '../../data/api'
import { useECharts } from './useECharts'
import type * as echarts from 'echarts'

interface Props {
  points: MinutePoint[]
  height?: number
  /** 昨日收盘价（基准线） */
  prevClose?: number
}

/** 分时图：价格线 + 均价线 + 成交量柱 + 昨收基准线 */
export default function MinuteChart({ points, height = 380, prevClose }: Props) {
  const times = points.map((p) => p.time)
  const prices = points.map((p) => p.price)
  const avgPrices = points.map((p) => p.avgPrice)
  const volumes = points.map((p) => ({
    value: p.volume,
    itemStyle: {
      color:
        prevClose !== undefined && p.price >= prevClose ? '#e03131' : '#2f9e44',
    },
  }))

  const option: echarts.EChartsCoreOption = {
    animation: false,
    tooltip: {
      trigger: 'axis',
      axisPointer: { type: 'cross' },
      backgroundColor: 'rgba(255,255,255,0.95)',
      borderColor: '#ddd',
      textStyle: { color: '#333', fontSize: 12 },
    },
    grid: [
      { left: 55, right: 20, top: 20, height: '58%' },
      { left: 55, right: 20, top: '72%', height: '18%' },
    ],
    xAxis: [
      { type: 'category', data: times, axisLine: { lineStyle: { color: '#999' } } },
      {
        type: 'category',
        gridIndex: 1,
        data: times,
        axisLabel: { show: false },
        axisLine: { lineStyle: { color: '#999' } },
      },
    ],
    yAxis: [
      {
        scale: true,
        splitLine: { lineStyle: { color: '#eee' } },
        axisLabel: { formatter: (v: number) => v.toFixed(2) },
      },
      { gridIndex: 1, scale: true, axisLabel: { show: false }, splitLine: { show: false } },
    ],
    series: [
      {
        name: '价格',
        type: 'line',
        data: prices,
        showSymbol: false,
        lineStyle: { width: 1.5, color: '#1971c2' },
        areaStyle: { color: 'rgba(25,113,194,0.08)' },
      },
      {
        name: '均价',
        type: 'line',
        data: avgPrices,
        showSymbol: false,
        lineStyle: { width: 1, color: '#f59f00' },
      },
      {
        name: '昨收',
        type: 'line',
        data: prevClose !== undefined ? Array(points.length).fill(prevClose) : [],
        showSymbol: false,
        lineStyle: { width: 1, color: '#868e96', type: 'dashed' },
        label: {
          show: true,
          position: 'end',
          formatter: prevClose !== undefined ? prevClose.toFixed(2) : '',
          fontSize: 10,
          color: '#868e96',
        },
      },
      {
        name: '成交量',
        type: 'bar',
        xAxisIndex: 1,
        yAxisIndex: 1,
        data: volumes,
      },
    ],
  }

  const ref = useECharts(option, [points, prevClose])
  return <div ref={ref} style={{ width: '100%', height }} />
}
