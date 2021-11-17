/**
 * @license
 * Copyright Google LLC All Rights Reserved.
 *
 * Use of this source code is governed by an MIT-style license that can be
 * found in the LICENSE file at https://angular.io/license
 */

import {createEnvironmentInjector, EnvironmentInjector, Injector, NgModuleRef, Type} from '@angular/core';
import {from, Observable, Observer, of} from 'rxjs';
import {switchMap} from 'rxjs/operators';

import {Data, ResolveData, Route, Routes} from './models';
import {ActivatedRouteSnapshot, inheritedParamsDataResolve, ParamsInheritanceStrategy, RouterStateSnapshot} from './router_state';
import {PRIMARY_OUTLET} from './shared';
import {UrlSegment, UrlSegmentGroup, UrlSerializer, UrlTree} from './url_tree';
import {last} from './utils/collection';
import {getOrCreateRouteInjectorIfNeeded, getOutlet, sortByMatchingOutlets} from './utils/config';
import {isImmediateMatch, matchWithChecks, noLeftoversInUrl, split} from './utils/config_matching';
import {TreeNode} from './utils/tree';

const NG_DEV_MODE = typeof ngDevMode === 'undefined' || !!ngDevMode;

class NoMatch {}

function newObservableError(e: unknown): Observable<RouterStateSnapshot> {
  // TODO(atscott): This pattern is used throughout the router code and can be `throwError` instead.
  return new Observable<RouterStateSnapshot>((obs: Observer<RouterStateSnapshot>) => obs.error(e));
}

export function recognize(
    injector: EnvironmentInjector, rootComponentType: Type<any>|null, config: Routes,
    urlTree: UrlTree, url: string, urlSerializer: UrlSerializer,
    paramsInheritanceStrategy: ParamsInheritanceStrategy = 'emptyOnly',
    relativeLinkResolution: 'legacy'|'corrected' = 'legacy'): Observable<RouterStateSnapshot> {
  try {
    const result = new Recognizer(
                       injector, rootComponentType, config, urlTree, url, paramsInheritanceStrategy,
                       relativeLinkResolution, urlSerializer)
                       .recognize();
    return from(result).pipe(switchMap(result => {
      if (result === null) {
        return newObservableError(new NoMatch());
      } else {
        return of(result);
      }
    }));
  } catch (e) {
    // Catch the potential error from recognize due to duplicate outlet matches and return as an
    // `Observable` error instead.
    return newObservableError(e);
  }
}

export class Recognizer {
  constructor(
      private injector: EnvironmentInjector, private rootComponentType: Type<any>|null,
      private config: Routes, private urlTree: UrlTree, private url: string,
      private paramsInheritanceStrategy: ParamsInheritanceStrategy,
      private relativeLinkResolution: 'legacy'|'corrected',
      private readonly urlSerializer: UrlSerializer) {}

  async recognize(): Promise<RouterStateSnapshot|null> {
    const rootSegmentGroup =
        split(
            this.urlTree.root, [], [], this.config.filter(c => c.redirectTo === undefined),
            this.relativeLinkResolution)
            .segmentGroup;

    const children = await this.processSegmentGroup(
        this.injector, this.config, rootSegmentGroup, PRIMARY_OUTLET);
    if (children === null) {
      return null;
    }

    // Use Object.freeze to prevent readers of the Router state from modifying it outside of a
    // navigation, resulting in the router being out of sync with the browser.
    const root = new ActivatedRouteSnapshot(
        [], Object.freeze({}), Object.freeze({...this.urlTree.queryParams}), this.urlTree.fragment,
        {}, PRIMARY_OUTLET, this.rootComponentType, null, this.urlTree.root, -1, {});

    const rootNode = new TreeNode<ActivatedRouteSnapshot>(root, children);
    const routeState = new RouterStateSnapshot(this.url, rootNode);
    this.inheritParamsAndData(routeState._root);
    return routeState;
  }

  inheritParamsAndData(routeNode: TreeNode<ActivatedRouteSnapshot>): void {
    const route = routeNode.value;

    const i = inheritedParamsDataResolve(route, this.paramsInheritanceStrategy);
    route.params = Object.freeze(i.params);
    route.data = Object.freeze(i.data);

    routeNode.children.forEach(n => this.inheritParamsAndData(n));
  }

  async processSegmentGroup(
      injector: EnvironmentInjector, config: Route[], segmentGroup: UrlSegmentGroup,
      outlet: string): Promise<TreeNode<ActivatedRouteSnapshot>[]|null> {
    if (segmentGroup.segments.length === 0 && segmentGroup.hasChildren()) {
      return this.processChildren(injector, config, segmentGroup);
    }

    return this.processSegment(injector, config, segmentGroup, segmentGroup.segments, outlet);
  }

  /**
   * Matches every child outlet in the `segmentGroup` to a `Route` in the config. Returns `null` if
   * we cannot find a match for _any_ of the children.
   *
   * @param config - The `Routes` to match against
   * @param segmentGroup - The `UrlSegmentGroup` whose children need to be matched against the
   *     config.
   */
  async processChildren(
      injector: EnvironmentInjector, config: Route[],
      segmentGroup: UrlSegmentGroup): Promise<TreeNode<ActivatedRouteSnapshot>[]|null> {
    const children: Array<TreeNode<ActivatedRouteSnapshot>> = [];
    for (const childOutlet of Object.keys(segmentGroup.children)) {
      const child = segmentGroup.children[childOutlet];
      // Sort the config so that routes with outlets that match the one being activated appear
      // first, followed by routes for other outlets, which might match if they have an empty path.
      const sortedConfig = sortByMatchingOutlets(config, childOutlet);
      const outletChildren =
          await this.processSegmentGroup(injector, sortedConfig, child, childOutlet);
      if (outletChildren === null) {
        // Configs must match all segment children so because we did not find a match for this
        // outlet, return `null`.
        return null;
      }
      children.push(...outletChildren);
    }
    // Because we may have matched two outlets to the same empty path segment, we can have multiple
    // activated results for the same outlet. We should merge the children of these results so the
    // final return value is only one `TreeNode` per outlet.
    const mergedChildren = mergeEmptyPathMatches(children);
    if (typeof ngDevMode === 'undefined' || ngDevMode) {
      // This should really never happen - we are only taking the first match for each outlet and
      // merge the empty path matches.
      checkOutletNameUniqueness(mergedChildren);
    }
    sortActivatedRouteSnapshots(mergedChildren);
    return mergedChildren;
  }

  async processSegment(
      injector: EnvironmentInjector, config: Route[], segmentGroup: UrlSegmentGroup,
      segments: UrlSegment[], outlet: string): Promise<TreeNode<ActivatedRouteSnapshot>[]|null> {
    for (const r of config) {
      const children = await this.processSegmentAgainstRoute(
          r._injector ?? injector, r, segmentGroup, segments, outlet);
      if (children !== null) {
        return children;
      }
    }
    if (noLeftoversInUrl(segmentGroup, segments, outlet)) {
      return [];
    }

    return null;
  }

  async processSegmentAgainstRoute(
      injector: EnvironmentInjector, route: Route, rawSegment: UrlSegmentGroup,
      segments: UrlSegment[], outlet: string): Promise<TreeNode<ActivatedRouteSnapshot>[]|null> {
    if (route.redirectTo || !isImmediateMatch(route, rawSegment, segments, outlet)) return null;

    let snapshot: ActivatedRouteSnapshot;
    let consumedSegments: UrlSegment[] = [];
    let remainingSegments: UrlSegment[] = [];

    if (route.path === '**') {
      injector = getOrCreateRouteInjectorIfNeeded(route, injector);
      const params = segments.length > 0 ? last(segments)!.parameters : {};
      const pathIndexShift = getPathIndexShift(rawSegment) + segments.length;
      snapshot = new ActivatedRouteSnapshot(
          segments, params, Object.freeze({...this.urlTree.queryParams}), this.urlTree.fragment,
          getData(route), getOutlet(route), route.component ?? route._loadedComponent ?? null,
          route, getSourceSegmentGroup(rawSegment), pathIndexShift, getResolve(route),
          // NG_DEV_MODE is used to prevent the getCorrectedPathIndexShift function from affecting
          // production bundle size. This value is intended only to surface a warning to users
          // depending on `relativeLinkResolution: 'legacy'` in dev mode.
          (NG_DEV_MODE ? getCorrectedPathIndexShift(rawSegment) + segments.length :
                         pathIndexShift));
    } else {
      const result =
          await matchWithChecks(rawSegment, route, segments, injector, this.urlSerializer)
              .toPromise();
      if (!result.matched) {
        return null;
      }
      consumedSegments = result.consumedSegments;
      remainingSegments = result.remainingSegments;
      const pathIndexShift = getPathIndexShift(rawSegment) + consumedSegments.length;

      snapshot = new ActivatedRouteSnapshot(
          consumedSegments, result.parameters, Object.freeze({...this.urlTree.queryParams}),
          this.urlTree.fragment, getData(route), getOutlet(route),
          route.component ?? route._loadedComponent ?? null, route,
          getSourceSegmentGroup(rawSegment), pathIndexShift, getResolve(route),
          (NG_DEV_MODE ? getCorrectedPathIndexShift(rawSegment) + consumedSegments.length :
                         pathIndexShift));
    }

    injector = getOrCreateRouteInjectorIfNeeded(route, injector);
    const childInjector = route._loadedInjector ?? injector;
    const childConfig: Route[] = getChildConfig(route);

    const {segmentGroup, slicedSegments} = split(
        rawSegment, consumedSegments, remainingSegments,
        // Filter out routes with redirectTo because we are trying to create activated route
        // snapshots and don't handle redirects here. That should have been done in
        // `applyRedirects`.
        childConfig.filter(c => c.redirectTo === undefined), this.relativeLinkResolution);

    if (slicedSegments.length === 0 && segmentGroup.hasChildren()) {
      const children = await this.processChildren(childInjector, childConfig, segmentGroup);
      if (children === null) {
        return null;
      }
      return [new TreeNode<ActivatedRouteSnapshot>(snapshot, children)];
    }

    if (childConfig.length === 0 && slicedSegments.length === 0) {
      return [new TreeNode<ActivatedRouteSnapshot>(snapshot, [])];
    }

    const matchedOnOutlet = getOutlet(route) === outlet;
    // If we matched a config due to empty path match on a different outlet, we need to continue
    // passing the current outlet for the segment rather than switch to PRIMARY.
    // Note that we switch to primary when we have a match because outlet configs look like this:
    // {path: 'a', outlet: 'a', children: [
    //  {path: 'b', component: B},
    //  {path: 'c', component: C},
    // ]}
    // Notice that the children of the named outlet are configured with the primary outlet
    const children = await this.processSegment(
        childInjector, childConfig, segmentGroup, slicedSegments,
        matchedOnOutlet ? PRIMARY_OUTLET : outlet);
    if (children === null) {
      return null;
    }
    return [new TreeNode<ActivatedRouteSnapshot>(snapshot, children)];
  }
}

function sortActivatedRouteSnapshots(nodes: TreeNode<ActivatedRouteSnapshot>[]): void {
  nodes.sort((a, b) => {
    if (a.value.outlet === PRIMARY_OUTLET) return -1;
    if (b.value.outlet === PRIMARY_OUTLET) return 1;
    return a.value.outlet.localeCompare(b.value.outlet);
  });
}

function getChildConfig(route: Route): Route[] {
  if (route.children) {
    return route.children;
  }

  if (route.loadChildren) {
    return route._loadedRoutes!;
  }

  return [];
}

function hasEmptyPathConfig(node: TreeNode<ActivatedRouteSnapshot>) {
  const config = node.value.routeConfig;
  return config && config.path === '' && config.redirectTo === undefined;
}

/**
 * Finds `TreeNode`s with matching empty path route configs and merges them into `TreeNode` with the
 * children from each duplicate. This is necessary because different outlets can match a single
 * empty path route config and the results need to then be merged.
 */
function mergeEmptyPathMatches(nodes: Array<TreeNode<ActivatedRouteSnapshot>>):
    Array<TreeNode<ActivatedRouteSnapshot>> {
  const result: Array<TreeNode<ActivatedRouteSnapshot>> = [];
  // The set of nodes which contain children that were merged from two duplicate empty path nodes.
  const mergedNodes: Set<TreeNode<ActivatedRouteSnapshot>> = new Set();

  for (const node of nodes) {
    if (!hasEmptyPathConfig(node)) {
      result.push(node);
      continue;
    }

    const duplicateEmptyPathNode =
        result.find(resultNode => node.value.routeConfig === resultNode.value.routeConfig);
    if (duplicateEmptyPathNode !== undefined) {
      duplicateEmptyPathNode.children.push(...node.children);
      mergedNodes.add(duplicateEmptyPathNode);
    } else {
      result.push(node);
    }
  }
  // For each node which has children from multiple sources, we need to recompute a new `TreeNode`
  // by also merging those children. This is necessary when there are multiple empty path configs in
  // a row. Put another way: whenever we combine children of two nodes, we need to also check if any
  // of those children can be combined into a single node as well.
  for (const mergedNode of mergedNodes) {
    const mergedChildren = mergeEmptyPathMatches(mergedNode.children);
    result.push(new TreeNode(mergedNode.value, mergedChildren));
  }
  return result.filter(n => !mergedNodes.has(n));
}

function checkOutletNameUniqueness(nodes: TreeNode<ActivatedRouteSnapshot>[]): void {
  const names: {[k: string]: ActivatedRouteSnapshot} = {};
  nodes.forEach(n => {
    const routeWithSameOutletName = names[n.value.outlet];
    if (routeWithSameOutletName) {
      const p = routeWithSameOutletName.url.map(s => s.toString()).join('/');
      const c = n.value.url.map(s => s.toString()).join('/');
      throw new Error(`Two segments cannot have the same outlet name: '${p}' and '${c}'.`);
    }
    names[n.value.outlet] = n.value;
  });
}

function getSourceSegmentGroup(segmentGroup: UrlSegmentGroup): UrlSegmentGroup {
  let s = segmentGroup;
  while (s._sourceSegment) {
    s = s._sourceSegment;
  }
  return s;
}

function getPathIndexShift(segmentGroup: UrlSegmentGroup): number {
  let s = segmentGroup;
  let res = s._segmentIndexShift ?? 0;
  while (s._sourceSegment) {
    s = s._sourceSegment;
    res += s._segmentIndexShift ?? 0;
  }
  return res - 1;
}

function getCorrectedPathIndexShift(segmentGroup: UrlSegmentGroup): number {
  let s = segmentGroup;
  let res = s._segmentIndexShiftCorrected ?? s._segmentIndexShift ?? 0;
  while (s._sourceSegment) {
    s = s._sourceSegment;
    res += s._segmentIndexShiftCorrected ?? s._segmentIndexShift ?? 0;
  }
  return res - 1;
}

function getData(route: Route): Data {
  return route.data || {};
}

function getResolve(route: Route): ResolveData {
  return route.resolve || {};
}
