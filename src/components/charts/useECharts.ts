import { useEffect, useRef } from 'react'
import * as echarts from 'echarts/core'
import {
  CandlestickChart,
  LineChart,
  BarChart,
  RadarChart,
} from 'echarts/charts'
import {
  GridComponent,
  TooltipComponent,
  DataZoomComponent,
  LegendComponent,
} from 'echarts/components'
import { CanvasRenderer } from 'echarts/renderers'

// 按需注册，tree-shaking 生效，显著减小包体积
echarts.use([
  CandlestickChart,
  LineChart,
  BarChart,
  RadarChart,
  GridComponent,
  TooltipComponent,
  DataZoomComponent,
  LegendComponent,
  CanvasRenderer,
])

/**
 * ECharts 封装 hook：
 *   const ref = useECharts(option, [deps])
 * 自动 init / setOption / resize / dispose。
 */
export function useECharts(option: echarts.EChartsCoreOption, deps: unknown[]) {
  const ref = useRef<HTMLDivElement>(null)
  const chartRef = useRef<echarts.ECharts | null>(null)

  useEffect(() => {
    const el = ref.current
    if (!el) return
    if (!chartRef.current) {
      chartRef.current = echarts.init(el)
    }
    chartRef.current.setOption(option, true)
  }, deps)

  useEffect(() => {
    const onResize = () => chartRef.current?.resize()
    window.addEventListener('resize', onResize)
    return () => {
      window.removeEventListener('resize', onResize)
      chartRef.current?.dispose()
      chartRef.current = null
    }
  }, [])

  return ref
}
