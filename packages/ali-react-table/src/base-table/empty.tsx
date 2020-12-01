import cx from 'classnames'
import React from 'react'
import { Classes } from './styles'

const DefaultEmptyContent = React.memo(() => (
  <>
    <img alt="empty-image" className="empty-image" src="//img.alicdn.com/tfs/TB1l1LcM3HqK1RjSZJnXXbNLpXa-50-50.svg" />
    <div className="empty-tips">
      没有符合查询条件的数据
      <br />
      请修改条件后重新查询
    </div>
  </>
))

export interface EmptyTableProps {
  colgroup: React.ReactNode
  colSpan: number
  isLoading: boolean
  emptyCellHeight?: number
  EmptyContent?: React.ComponentType
}

export default function EmptyTable({
  colgroup,
  colSpan,
  isLoading,
  emptyCellHeight,
  EmptyContent = DefaultEmptyContent,
}: EmptyTableProps) {
  const show = !isLoading

  return (
    <table>
      {colgroup}
      <tbody>
        <tr className={cx(Classes.tableRow, 'first', 'last', 'no-hover')} data-rowindex={0}>
          <td
            className={cx(Classes.tableCell, 'first', 'last')}
            colSpan={colSpan}
            style={{ height: emptyCellHeight ?? 200 }}
          >
            {show && (
              <div className={Classes.emptyWrapper}>
                <EmptyContent />
              </div>
            )}
          </td>
        </tr>
      </tbody>
    </table>
  )
}
