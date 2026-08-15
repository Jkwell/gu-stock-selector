import type { Kline } from '../../types'
import { sma } from '../../engine/indicators'
import { useECharts } from './useECharts'
import type * as echarts from 'echarts'

interface Props {
  kline: Kline[]
  height?: number
}

/** K 线图：蜡烛图 + MA5/MA20 + 成交量 */
export default function KLineChart({ kline, height = 420 }: Props) {
  const close = kline.map((k) => k.close)
  const ma5 = sma(close, 5)
  const ma20 = sma(close, 20)

  const dates = kline.map((k) => k.date)
  const candles = kline.map((k) => [k.open, k.close, k.low, k.high])
  const volumes = kline.map((k) => ({
    value: k.volume,
    itemStyle: {
      color: k.close >= k.open ? '#e03131' : '#2f9e44',
    },
  }))

  const option: echarts.EChartsOption = {
    animation: false,
    backgroundColor: 'transparent',
    tooltip: {
      trigger: 'axis',
      axisPointer: { type: 'cross' },
      backgroundColor: 'rgba(255,255,255,0.95)',
      borderColor: '#ddd',
      textStyle: { color: '#333', fontSize: 12 },
    },
    axisPointer: { link: [{ xAxisIndex: 'all' }] },
    grid: [
      { left: 60, right: 20, top: 20, height: '55%' },
      { left: 60, right: 20, top: '70%', height: '20%' },
    ],
    xAxis: [
      {
        type: 'category',
        data: dates,
        boundaryGap: true,
        axisLine: { lineStyle: { color: '#999' } },
      },
      {
        type: 'category',
        gridIndex: 1,
        data: dates,
        axisLabel: { show: false },
        axisLine: { lineStyle: { color: '#999' } },
      },
    ],
    yAxis: [
      { scale: true, splitLine: { lineStyle: { color: '#eee' } } },
      {
        gridIndex: 1,
        scale: true,
        axisLabel: { show: false },
        splitLine: { show: false },
      },
    ],
    dataZoom: [
      { type: 'inside', xAxisIndex: [0, 1], start: 60, end: 100 },
      { type: 'slider', xAxisIndex: [0, 1], start: 60, end: 100, height: 18, bottom: 4 },
    ],
    series: [
      {
        name: 'K线',
        type: 'candlestick',
        data: candles,
        itemStyle: {
          color: '#e03131',
          color0: '#2f9e44',
          borderColor: '#e03131',
          borderColor0: '#2f9e44',
        },
      },
      {
        name: 'MA5',
        type: 'line',
        data: ma5,
        smooth: true,
        showSymbol: false,
        lineStyle: { width: 1, color: '#f59f00' },
      },
      {
        name: 'MA20',
        type: 'line',
        data: ma20,
        smooth: true,
        showSymbol: false,
        lineStyle: { width: 1, color: '#1971c2' },
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

  const ref = useECharts(option, [kline])
  return <div ref={ref} style={{ width: '100%', height }} />
}
