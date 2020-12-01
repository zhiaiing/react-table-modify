import React from 'react'
import { SortItem } from '../../interfaces'
import { makeSortTransform, SortOptions } from '../../transforms'
import { TablePipeline } from '../pipeline'

export type SortFeatureOptions = { defaultSorts?: SortItem[] } & Partial<SortOptions>

export function sort(opts: SortFeatureOptions = {}) {
  return function sortStep<P extends TablePipeline>(pipeline: P) {
    const stateKey = 'sort'

    return pipeline.useTransform(
      makeSortTransform({
        ...opts,
        sorts: opts.sorts ?? pipeline.getStateAtKey(stateKey) ?? opts.defaultSorts ?? [],
        keepDataSource: opts.keepDataSource,
        onChangeSorts: (nextSorts) => {
          opts.onChangeSorts?.(nextSorts)
          pipeline.setStateAtKey(stateKey, nextSorts)
        },
      }),
    )
  }
}
