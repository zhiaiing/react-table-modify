import cx from 'classnames'
import React, { CSSProperties, ReactNode } from 'react'
import { animationFrameScheduler, BehaviorSubject, combineLatest, noop, of, Subscription, timer } from 'rxjs'
import * as op from 'rxjs/operators'
import { ArtColumn } from '../interfaces'
import { internals } from '../internals'
import EmptyTable from './empty'
import getDerivedStateFromProps from './getDerivedStateFromProps'
import TableHeader from './header'
import { getFullRenderRange, makeRowHeightManager } from './helpers/rowHeightManager'
import SpanManager from './helpers/SpanManager'
import { getVisiblePartObservable } from './helpers/visible-part'
import {
  FullRenderRange,
  HorizontalRenderRange,
  HozWrappedCol,
  TableDoms,
  VerticalRenderRange,
  VirtualEnum,
} from './interfaces'
import Loading, { LoadingContentWrapperProps } from './loading'
import { BaseTableCSSVariables, Classes, LOCK_SHADOW_PADDING, StyledArtTableWrapper } from './styles'
import {
  getScrollbarSize,
  OVERSCAN_SIZE,
  query,
  queryAll,
  shallowEqual,
  STYLED_REF_PROP,
  sum,
  syncScrollLeft,
  throttledWindowResize$,
} from './utils'

let propsDotEmptyContentDeprecatedWarned = false
function warnPropsDotEmptyContentIsDeprecated() {
  if (!propsDotEmptyContentDeprecatedWarned) {
    propsDotEmptyContentDeprecatedWarned = true
    console.warn(
      '[ali-react-table] BaseTable props.emptyContent 已经过时，请使用 props.components.EmptyContent 来自定义数据为空时的表格表现',
    )
  }
}

export type PrimaryKey = string | ((record: any) => string)

export interface BaseTableProps {
  /** 主键 */
  primaryKey?: PrimaryKey
  /** 表格展示的数据源 */
  dataSource: any[]
  /** 表格的列配置 */
  columns: ArtColumn[]

  /** 是否开启虚拟滚动 */
  useVirtual?: VirtualEnum | { horizontal?: VirtualEnum; vertical?: VirtualEnum; header?: VirtualEnum }
  /** 虚拟滚动开启情况下，表格中每一行的预估高度 */
  estimatedRowHeight?: number

  /** 表格头部是否置顶，默认为 true */
  isStickyHead?: boolean
  /** 表格置顶后，距离顶部的距离 */
  stickyTop?: number
  /** 表格置顶后，距离底部的距离 */
  stickyBottom?: number
  /** 自定义类名 */
  className?: string
  /** 自定义内联样式 */
  style?: CSSProperties & BaseTableCSSVariables
  /** 表格是否具有头部 */
  hasHeader?: boolean
  /** 使用来自外层 div 的边框代替单元格的外边框 */
  useOuterBorder?: boolean

  /** 表格是否在加载中 */
  isLoading?: boolean
  /** 数据为空时，单元格的高度 */
  emptyCellHeight?: number
  /** @deprecated 数据为空时，表格的展示内容。请使用 components.EmptyContent 代替 */
  emptyContent?: ReactNode

  /** 覆盖表格内部用到的组件 */
  components?: {
    /** 表格加载时，表格内容的父组件 */
    LoadingContentWrapper?: React.ComponentType<LoadingContentWrapperProps>
    /** 表格加载时的加载图标 */
    LoadingIcon?: React.ComponentType
    /** 数据为空时，表格的展示内容。*/
    EmptyContent?: React.ComponentType
  }

  /** 列的默认宽度 */
  defaultColumnWidth?: number

  /** 表格所处于的块格式化上下文(BFC)
   * https://developer.mozilla.org/zh-CN/docs/Web/Guide/CSS/Block_formatting_context */
  flowRoot?: 'auto' | 'self' | (() => HTMLElement | typeof window) | HTMLElement | typeof window

  getRowProps?(record: any, rowIndex: number): React.HTMLAttributes<HTMLTableRowElement>
}

export interface BaseTableState {
  flat: { full: ArtColumn[]; left: ArtColumn[]; center: ArtColumn[]; right: ArtColumn[] }
  nested: { full: ArtColumn[]; left: ArtColumn[]; center: ArtColumn[]; right: ArtColumn[] }
  stickyLeftMap: Map<number, number>
  stickyRightMap: Map<number, number>

  /** 是否要展示自定义滚动条(stickyScroll) */
  hasScroll: boolean

  /** 是否需要渲染 lock sections
   * 当表格较宽时，所有的列都能被完整的渲染，此时不需要渲染 lock sections
   * 只有当「整个表格的宽度」小于「每一列渲染宽度之和」时，lock sections 才需要被渲染 */
  needRenderLock: boolean

  /** 是否需要启用虚拟滚动 */
  useVirtual: {
    horizontal: boolean
    vertical: boolean
    header: boolean
  }

  /** 纵向虚拟滚动偏移量 */
  offsetY: number
  /** 纵向虚拟滚动 最大渲染尺寸 */
  maxRenderHeight: number
  /** 横向虚拟滚动偏移量 */
  offsetX: number
  /** 横向虚拟滚动 最大渲染尺寸 */
  maxRenderWidth: number
}

export class BaseTable extends React.Component<BaseTableProps, BaseTableState> {
  static defaultProps = {
    isStickyHead: true,
    stickyTop: 0,
    stickyBottom: 0,
    useVirtual: 'auto',
    estimatedRowHeight: 48,
    hasHeader: true,
    isLoading: false,
    components: {},
    getRowProps: noop,
    flowRoot: 'auto',
  }

  static getDerivedStateFromProps = getDerivedStateFromProps

  private rowHeightManager = makeRowHeightManager(this.props.dataSource.length, this.props.estimatedRowHeight)

  private artTableWrapperRef = React.createRef<HTMLDivElement>()
  private doms: TableDoms
  private rootSubscription = new Subscription()

  private data$: BehaviorSubject<{
    props: BaseTableProps
    state: BaseTableState
    prevProps: BaseTableProps | null
    prevState: BaseTableState | null
  }>

  getDoms() {
    return this.doms
  }

  constructor(props: Readonly<BaseTableProps>) {
    super(props)

    this.state = {
      ...getDerivedStateFromProps(props, null),
      hasScroll: true,
      needRenderLock: true,
      offsetY: 0,
      offsetX: 0,
      // 因为 ResizeObserver 在一开始总是会调用一次所提供的回调函数
      // 故这里为 maxRenderHeight/maxRenderWidth 设置一个默认值即可（因为这两个默认值很快就会被覆盖）
      // https://stackoverflow.com/questions/60026223/does-resizeobserver-invokes-initially-on-page-load
      maxRenderHeight: 600,
      maxRenderWidth: 800,
    }
  }

  /** 自定义滚动条宽度为table宽度，使滚动条滑块宽度相同 */
  private updateStickyScroll() {
    const { stickyScroll, artTable, stickyScrollItem } = this.doms

    if (!artTable) {
      return
    }
    const tableBodyInnerTable = artTable.querySelector(`.${Classes.tableBody} table`) as HTMLTableElement
    const innerTableWidth = tableBodyInnerTable.offsetWidth
    const artTableWidth = artTable.offsetWidth

    const scrollbarSize = getScrollbarSize()
    stickyScroll.style.marginTop = `-${scrollbarSize.height}px`

    if (artTableWidth >= innerTableWidth) {
      if (this.state.hasScroll) {
        this.setState({ hasScroll: false })
      }
    } else {
      if (!this.state.hasScroll && scrollbarSize.height > 5) {
        // 考虑下mac下面隐藏滚动条的情况
        this.setState({ hasScroll: true })
      }
    }
    // 设置子节点宽度
    stickyScrollItem.style.width = `${innerTableWidth}px`
  }

  private renderTableHeader({ horizontal: hoz }: FullRenderRange) {
    const { stickyTop, hasHeader } = this.props
    const { flat, nested, useVirtual, stickyLeftMap, stickyRightMap } = this.state

    return (
      <div
        className={cx(Classes.tableHeader, 'no-scrollbar')}
        style={{
          top: stickyTop === 0 ? undefined : stickyTop,
          display: hasHeader ? undefined : 'none',
        }}
      >
        <TableHeader
          nested={nested}
          flat={flat}
          hoz={hoz}
          useVirtual={useVirtual}
          stickyLeftMap={stickyLeftMap}
          stickyRightMap={stickyRightMap}
        />
      </div>
    )
  }

  private updateOffsetX(nextOffsetX: number) {
    if (this.state.useVirtual.horizontal) {
      if (Math.abs(nextOffsetX - this.state.offsetX) >= OVERSCAN_SIZE / 2) {
        this.setState({ offsetX: nextOffsetX })
      }
    }
  }

  private syncHorizontalScrollFromTableBody() {
    this.syncHorizontalScroll(this.doms.tableBody.scrollLeft)
  }

  /** 同步横向滚动偏移量 */
  private syncHorizontalScroll(x: number) {
    this.updateOffsetX(x)

    const { tableBody, artTableWrapper } = this.doms
    const { flat } = this.state

    const showLeftLockShadow = flat.left.length > 0 && this.state.needRenderLock && x > 0
    const leftLockShadow = query(artTableWrapper, Classes.leftLockShadow)
    if (showLeftLockShadow) {
      leftLockShadow.classList.add('show-shadow')
    } else {
      leftLockShadow.classList.remove('show-shadow')
    }

    const showRightLockShadow =
      flat.right.length > 0 && this.state.needRenderLock && x < tableBody.scrollWidth - tableBody.clientWidth
    const rightLockShadow = query(artTableWrapper, Classes.rightLockShadow)
    if (showRightLockShadow) {
      rightLockShadow.classList.add('show-shadow')
    } else {
      rightLockShadow.classList.remove('show-shadow')
    }
  }

  private getVerticalRenderRange(): VerticalRenderRange {
    const { dataSource } = this.props
    const { useVirtual, offsetY, maxRenderHeight } = this.state
    const rowCount = dataSource.length
    if (useVirtual.vertical) {
      return this.rowHeightManager.getRenderRange(offsetY, maxRenderHeight, rowCount)
    } else {
      return getFullRenderRange(rowCount)
    }
  }

  private getHorizontalRenderRange(): HorizontalRenderRange {
    const { offsetX, maxRenderWidth, useVirtual, flat } = this.state

    if (!useVirtual.horizontal) {
      return { leftIndex: 0, leftBlank: 0, rightIndex: flat.full.length, rightBlank: 0 }
    }

    let leftIndex = 0
    let centerCount = 0
    let leftBlank = 0
    let centerRenderWidth = 0

    const overscannedOffsetX = Math.max(0, offsetX - OVERSCAN_SIZE)
    while (leftIndex < flat.center.length) {
      const col = flat.center[leftIndex]
      if (col.width + leftBlank < overscannedOffsetX) {
        leftIndex += 1
        leftBlank += col.width
      } else {
        break
      }
    }

    // 考虑 over scan 之后，中间部分的列至少需要渲染的宽度
    const minCenterRenderWidth = maxRenderWidth + (overscannedOffsetX - leftBlank) + 2 * OVERSCAN_SIZE

    while (leftIndex + centerCount < flat.center.length) {
      const col = flat.center[leftIndex + centerCount]
      if (col.width + centerRenderWidth < minCenterRenderWidth) {
        centerRenderWidth += col.width
        centerCount += 1
      } else {
        break
      }
    }

    const rightBlankCount = flat.center.length - leftIndex - centerCount
    const rightBlank = sum(flat.center.slice(flat.center.length - rightBlankCount).map((col) => col.width))
    return {
      leftIndex: leftIndex,
      leftBlank,
      rightIndex: leftIndex + centerCount,
      rightBlank,
    }
  }

  private getRenderRange(): FullRenderRange {
    return {
      vertical: this.getVerticalRenderRange(),
      horizontal: this.getHorizontalRenderRange(),
    }
  }

  private getFlatHozWrappedCols(hoz: HorizontalRenderRange): HozWrappedCol[] {
    const { flat } = this.state

    const wrappedCols: HozWrappedCol[] = [
      ...flat.left.map((col, i) => ({ type: 'normal', col, colIndex: i } as const)),
      hoz.leftBlank > 0 && { type: 'blank', blankSide: 'left', width: hoz.leftBlank },
      ...flat.center
        .slice(hoz.leftIndex, hoz.rightIndex)
        .map((col, i) => ({ type: 'normal', col, colIndex: flat.left.length + hoz.leftIndex + i } as const)),
      hoz.rightBlank > 0 && { type: 'blank', blankSide: 'right', width: hoz.rightBlank },
      ...flat.right.map(
        (col, i) => ({ type: 'normal', col, colIndex: flat.full.length - flat.right.length + i } as const),
      ),
    ]

    return wrappedCols.filter(Boolean)
  }

  private renderTableBody(renderRange: FullRenderRange) {
    const { vertical: ver, horizontal: hoz } = renderRange
    const { dataSource, getRowProps, primaryKey, isLoading, emptyCellHeight } = this.props
    const wrappedCols = this.getFlatHozWrappedCols(hoz)

    const colgroup = (
      <colgroup>
        {wrappedCols.map((wrapped) => {
          if (wrapped.type === 'blank') {
            return <col key={wrapped.blankSide} style={{ width: wrapped.width }} />
          }
          return <col key={wrapped.colIndex} style={{ width: wrapped.col.width }} />
        })}
      </colgroup>
    )

    if (ver.bottomIndex - ver.topIndex === 0) {
      const { components, emptyContent } = this.props
      let EmptyContent = components.EmptyContent
      if (EmptyContent == null && emptyContent != null) {
        warnPropsDotEmptyContentIsDeprecated()
        EmptyContent = ((() => emptyContent) as unknown) as React.ComponentType
      }

      return (
        <div className={Classes.tableBody}>
          <EmptyTable
            colgroup={colgroup}
            colSpan={wrappedCols.length}
            isLoading={isLoading}
            EmptyContent={EmptyContent}
            emptyCellHeight={emptyCellHeight}
          />
        </div>
      )
    }

    const { flat, stickyLeftMap, stickyRightMap } = this.state
    const fullFlatCount = flat.full.length
    const leftFlatCount = flat.left.length
    const rightFlatCount = flat.right.length

    const spanManager = new SpanManager()
    const rows = dataSource.slice(ver.topIndex, ver.bottomIndex).map(renderRow)

    return (
      <div className={Classes.tableBody}>
        <div key="top-blank" className={cx(Classes.virtualBlank, 'top')} style={{ height: ver.topBlank }} />
        <table>
          {colgroup}
          <tbody>{rows}</tbody>
        </table>
        <div key="bottom-blank" className={cx(Classes.virtualBlank, 'bottom')} style={{ height: ver.bottomBlank }} />
      </div>
    )

    function renderRow(record: any, i: number) {
      const rowIndex = ver.topIndex + i
      spanManager.stripUpwards(rowIndex)

      const rowProps = getRowProps(record, rowIndex)
      const rowClass = cx(
        Classes.tableRow,
        {
          first: rowIndex === 0,
          last: rowIndex === dataSource.length - 1,
          even: rowIndex % 2 === 0,
          odd: rowIndex % 2 === 1,
        },
        rowProps?.className,
      )
      return (
        <tr
          {...rowProps}
          className={rowClass}
          key={internals.safeGetRowKey(primaryKey, record, rowIndex)}
          data-rowindex={rowIndex}
        >
          {wrappedCols.map((wrapped) => {
            if (wrapped.type === 'blank') {
              return <td key={wrapped.blankSide} />
            }
            return renderCell(record, rowIndex, wrapped.col, wrapped.colIndex)
          })}
        </tr>
      )
    }

    function renderCell(record: any, rowIndex: number, column: ArtColumn, colIndex: number) {
      if (spanManager.testSkip(rowIndex, colIndex)) {
        return null
      }

      const value = internals.safeGetValue(column, record, rowIndex)
      const cellProps = column.getCellProps?.(value, record, rowIndex) ?? {}

      let cellContent: ReactNode = value
      if (column.render) {
        cellContent = column.render(value, record, rowIndex)
      }

      let colSpan = 1
      let rowSpan = 1
      if (column.getSpanRect) {
        const spanRect = column.getSpanRect(value, record, rowIndex)
        colSpan = spanRect == null ? 1 : spanRect.right - colIndex
        rowSpan = spanRect == null ? 1 : spanRect.bottom - rowIndex
      } else {
        if (cellProps.colSpan != null) {
          colSpan = cellProps.colSpan
        }
        if (cellProps.rowSpan != null) {
          rowSpan = cellProps.rowSpan
        }
      }

      // rowSpan/colSpan 不能过大，避免 rowSpan/colSpan 影响因虚拟滚动而未渲染的单元格
      rowSpan = Math.min(rowSpan, ver.bottomIndex - rowIndex)
      colSpan = Math.min(colSpan, leftFlatCount + hoz.rightIndex - colIndex)

      const hasSpan = colSpan > 1 || rowSpan > 1
      if (hasSpan) {
        spanManager.add(rowIndex, colIndex, colSpan, rowSpan)
      }

      const positionStyle: CSSProperties = {}

      if (colIndex < leftFlatCount) {
        positionStyle.position = 'sticky'
        positionStyle.left = stickyLeftMap.get(colIndex)
      } else if (colIndex >= fullFlatCount - rightFlatCount) {
        positionStyle.position = 'sticky'
        positionStyle.right = stickyRightMap.get(colIndex)
      }

      return React.createElement(
        'td',
        {
          key: colIndex,
          ...cellProps,
          className: cx(Classes.tableCell, cellProps.className, {
            first: colIndex === 0,
            last: colIndex + colSpan === fullFlatCount,
            'lock-left': colIndex < leftFlatCount,
            'lock-right': colIndex >= fullFlatCount - rightFlatCount,
          }),
          ...(hasSpan ? { colSpan, rowSpan } : null),
          style: {
            textAlign: column.align,
            ...cellProps.style,
            ...positionStyle,
          },
        },
        cellContent,
      )
    }
  }

  private isLock() {
    const { nested } = this.state
    return nested.left.length > 0 || nested.right.length > 0
  }

  render() {
    const { dataSource, className, style, hasHeader, useOuterBorder, isStickyHead, isLoading, components } = this.props
    const { flat } = this.state

    const styleWrapper = (node: ReactNode) => {
      const artTableWrapperClassName = cx(
        Classes.artTableWrapper,
        {
          'use-outer-border': useOuterBorder,
          sticky: isStickyHead,
          empty: dataSource.length === 0,
          lock: this.isLock(),
          'has-header': hasHeader,
        },
        className,
      )

      const artTableWrapperProps = {
        className: artTableWrapperClassName,
        style,
        [STYLED_REF_PROP]: this.artTableWrapperRef,
      }
      return <StyledArtTableWrapper {...artTableWrapperProps}>{node}</StyledArtTableWrapper>
    }

    const renderRange = this.getRenderRange()

    return styleWrapper(
      <Loading
        visible={isLoading}
        LoadingIcon={components.LoadingIcon}
        LoadingContentWrapper={components.LoadingContentWrapper}
      >
        <div className={Classes.artTable}>
          {this.renderTableHeader(renderRange)}
          {this.renderTableBody(renderRange)}

          <div
            className={Classes.lockShadowMask}
            style={{ left: 0, width: sum(flat.left.map((col) => col.width)) + LOCK_SHADOW_PADDING }}
          >
            <div className={cx(Classes.lockShadow, Classes.leftLockShadow)} />
          </div>
          <div
            className={Classes.lockShadowMask}
            style={{ right: 0, width: sum(flat.right.map((col) => col.width)) + LOCK_SHADOW_PADDING }}
          >
            <div className={cx(Classes.lockShadow, Classes.rightLockShadow)} />
          </div>
        </div>

        <div
          className={Classes.stickyScroll}
          style={{
            display: this.state.hasScroll ? 'block' : 'none',
            bottom: this.props.stickyBottom,
          }}
        >
          <div className={Classes.stickyScrollItem} />
        </div>
      </Loading>,
    )
  }

  componentDidMount() {
    this.updateDoms()
    this.data$ = new BehaviorSubject({
      props: this.props,
      state: this.state,
      prevProps: null,
      prevState: null,
    })
    this.initSubscriptions()
    this.didMountOrUpdate()
  }

  componentDidUpdate(prevProps: Readonly<BaseTableProps>, prevState: Readonly<BaseTableState>) {
    this.updateDoms()
    this.data$.next({
      props: this.props,
      state: this.state,
      prevProps,
      prevState,
    })
    this.didMountOrUpdate(prevProps, prevState)
  }

  private didMountOrUpdate(prevProps?: Readonly<BaseTableProps>, prevState?: Readonly<BaseTableState>) {
    this.syncHorizontalScrollFromTableBody()
    this.updateStickyScroll()
    this.adjustNeedRenderLock()
    this.updateRowHeightManager(prevProps)
    this.resetStickyScrollIfNecessary(prevState)
  }

  private resetStickyScrollIfNecessary(prevState: Readonly<BaseTableState>) {
    if (prevState != null && this.state.hasScroll && !prevState.hasScroll) {
      this.doms.stickyScroll.scrollLeft = 0
    }
  }

  private initSubscriptions() {
    const { tableHeader, tableBody, stickyScroll } = this.doms

    this.rootSubscription.add(
      throttledWindowResize$.subscribe(() => {
        this.updateStickyScroll()
        this.adjustNeedRenderLock()
      }),
    )

    // 滚动同步
    this.rootSubscription.add(
      syncScrollLeft([tableBody, stickyScroll, tableHeader], (scrollLeft) => {
        this.syncHorizontalScroll(scrollLeft)
      }),
    )

    // 表格所处的 flowRoot / BFC
    const resolvedFlowRoot$ = this.data$.pipe(
      op.map((data) => data.props.flowRoot),
      op.switchMap((flowRoot) => {
        const wrapper = this.artTableWrapperRef.current
        if (flowRoot === 'auto') {
          const computedStyle = getComputedStyle(wrapper)
          return of(computedStyle.overflowY !== 'visible' ? wrapper : window)
        } else if (flowRoot === 'self') {
          return of(wrapper)
        } else {
          if (typeof flowRoot === 'function') {
            // 在一些情况下 flowRoot 需要在父组件 didMount 时才会准备好
            // 故这里使用 animationFrameScheduler 等下一个动画帧
            return timer(0, animationFrameScheduler).pipe(op.map(flowRoot))
          } else {
            return of(flowRoot)
          }
        }
      }),
      op.distinctUntilChanged(),
    )

    // 表格在 flowRoot 中的可见部分
    const visiblePart$ = resolvedFlowRoot$.pipe(
      op.switchMap((resolvedFlowRoot) => {
        return getVisiblePartObservable(this.doms.artTable, resolvedFlowRoot)
      }),
    )

    // 每当可见部分发生变化的时候，调整 loading icon 的未知（如果 loading icon 存在的话）
    this.rootSubscription.add(
      combineLatest([
        visiblePart$.pipe(
          op.map((p) => p.clipRect),
          op.distinctUntilChanged(shallowEqual),
        ),
        this.data$.pipe(op.filter((data) => !data.prevProps?.isLoading && data.props.isLoading)),
      ]).subscribe(([clipRect]) => {
        const { artTableWrapper } = this.doms
        const loadingIndicator = query(artTableWrapper, Classes.loadingIndicator)
        if (!loadingIndicator) {
          return
        }
        const height = clipRect.bottom - clipRect.top
        loadingIndicator.style.top = `${height / 2}px`
        loadingIndicator.style.marginTop = `${height / 2}px`
      }),
    )

    // 每当可见部分发生变化的时候，如果开启了虚拟滚动，则重新触发 render
    this.rootSubscription.add(
      visiblePart$
        .pipe(
          op.filter(() => {
            const { horizontal, vertical } = this.state.useVirtual
            return horizontal || vertical
          }),
          op.map(({ clipRect, offsetY }) => ({
            maxRenderHeight: clipRect.bottom - clipRect.top,
            maxRenderWidth: clipRect.right - clipRect.left,
            offsetY,
          })),
          op.distinctUntilChanged((x, y) => {
            // 因为 overscan 的存在，滚动较小的距离时不需要触发组件重渲染
            return (
              Math.abs(x.maxRenderWidth - y.maxRenderWidth) < OVERSCAN_SIZE / 2 &&
              Math.abs(x.maxRenderHeight - y.maxRenderHeight) < OVERSCAN_SIZE / 2 &&
              Math.abs(x.offsetY - y.offsetY) < OVERSCAN_SIZE / 2
            )
          }),
        )
        .subscribe((sizeAndOffset) => {
          this.setState(sizeAndOffset)
        }),
    )
  }

  componentWillUnmount() {
    this.rootSubscription.unsubscribe()
  }

  /** 更新 DOM 节点的引用，方便其他方法直接操作 DOM */
  private updateDoms() {
    const artTableWrapper = this.artTableWrapperRef.current
    const artTable = query(artTableWrapper, Classes.artTable)

    this.doms = {
      artTableWrapper,
      artTable,
      tableHeader: query(artTable, Classes.tableHeader),
      tableBody: query(artTable, Classes.tableBody),

      stickyScroll: query(artTableWrapper, Classes.stickyScroll),
      stickyScrollItem: query(artTableWrapper, Classes.stickyScrollItem),
    }
  }

  private updateRowHeightManager(prevProps?: Readonly<BaseTableProps>) {
    const virtualTop = this.doms.artTable.querySelector<HTMLDivElement>(`.${Classes.virtualBlank}.top`)
    const virtualTopHeight = virtualTop?.clientHeight ?? 0

    let maxTrRowIndex = -1
    let maxTrBottom = -1

    for (const tr of queryAll<HTMLTableRowElement>(this.doms.artTable, Classes.tableRow)) {
      const rowIndex = Number(tr.dataset.rowindex)
      if (isNaN(rowIndex)) {
        continue
      }
      maxTrRowIndex = Math.max(maxTrRowIndex, rowIndex)
      const offset = tr.offsetTop + virtualTopHeight
      const size = tr.offsetHeight
      maxTrBottom = Math.max(maxTrBottom, offset + size)
      this.rowHeightManager.updateRow(rowIndex, offset, size)
    }

    // 当 estimatedRowHeight 过大时，可能出现「渲染行数过少，无法覆盖可视范围」的情况
    // 出现这种情况时，我们判断「下一次渲染能够渲染更多行」是否满足，满足的话就直接调用 forceUpdate
    if (maxTrRowIndex !== -1) {
      if (maxTrBottom < this.state.offsetY + this.state.maxRenderHeight) {
        const vertical = this.getVerticalRenderRange()
        if (vertical.bottomIndex - 1 > maxTrRowIndex) {
          this.forceUpdate()
        }
      }
    }
  }

  /** 计算表格所有列的渲染宽度之和，判断表格是否需要渲染锁列 */
  private adjustNeedRenderLock() {
    const { needRenderLock, flat } = this.state

    if (this.isLock()) {
      const sumOfColWidth = sum(flat.full.map((col) => col.width))
      const nextNeedRenderLock = sumOfColWidth > this.doms.artTable.clientWidth
      if (needRenderLock !== nextNeedRenderLock) {
        this.setState({ needRenderLock: nextNeedRenderLock })
      }
    } else {
      if (needRenderLock) {
        this.setState({ needRenderLock: false })
      }
    }
  }
}
