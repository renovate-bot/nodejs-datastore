/*!
 * Copyright 2014 Google LLC.
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *      http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

import {promisifyAll} from '@google-cloud/promisify';
import arrify = require('arrify');

// eslint-disable-next-line @typescript-eslint/no-var-requires
const concat = require('concat-stream');
import * as extend from 'extend';
import {split} from 'split-array-stream';
import {google} from '../protos/protos';
import {CallOptions, CancellableStream} from 'google-gax';
import {Duplex, PassThrough, Transform} from 'stream';

// eslint-disable-next-line @typescript-eslint/no-var-requires
const streamEvents = require('stream-events');
export const transactionExpiredError = 'This transaction has already expired.';

export interface AbortableDuplex extends Duplex {
  abort(): void;
}

interface TransactionRequestOptions {
  readOnly?: {};
  readWrite?: {previousTransaction?: string | Uint8Array | null};
}

// Import the clients for each version supported by this package.
const gapic = Object.freeze({
  v1: require('./v1'),
});

import {
  entity,
  Entity,
  EntityProto,
  KeyProto,
  ResponseResult,
  Entities,
} from './entity';
import {
  ExplainMetrics,
  ExplainOptions,
  Query,
  QueryProto,
  RunQueryInfo,
  RunQueryOptions,
  RunQueryResponse,
  RunQueryCallback,
} from './query';
import {Datastore, Transaction} from '.';
import ITimestamp = google.protobuf.ITimestamp;
import {AggregateQuery} from './aggregate';
import {RunOptions} from './transaction';
import * as protos from '../protos/protos';
import {serializer} from 'google-gax';
import * as gax from 'google-gax';
import {SaveDataValue} from './interfaces/save';

type JSONValue =
  | string
  | number
  | boolean
  | null
  | JSONValue[]
  | {
      [key: string]: JSONValue;
    };

const root = gax.protobuf.loadSync('google/protobuf/struct.proto');
const Struct = root.lookupType('Struct');

// This function decodes Struct proto values
function decodeStruct(structValue: google.protobuf.IStruct): JSONValue {
  return serializer.toProto3JSON(Struct.fromObject(structValue) as any);
}

// This function gets a RunQueryInfo object that contains explain metrics that
// were returned from the server.
function getInfoFromStats(
  resp:
    | protos.google.datastore.v1.IRunQueryResponse
    | protos.google.datastore.v1.IRunAggregationQueryResponse,
): RunQueryInfo {
  // Decode struct values stored in planSummary and executionStats
  const explainMetrics: ExplainMetrics = {};
  if (
    resp &&
    resp.explainMetrics &&
    resp.explainMetrics.planSummary &&
    resp.explainMetrics.planSummary.indexesUsed
  ) {
    Object.assign(explainMetrics, {
      planSummary: {
        indexesUsed: resp.explainMetrics.planSummary.indexesUsed.map(
          (index: google.protobuf.IStruct) => decodeStruct(index),
        ),
      },
    });
  }
  if (resp && resp.explainMetrics && resp.explainMetrics.executionStats) {
    const executionStats = {};
    {
      const resultsReturned =
        resp.explainMetrics.executionStats.resultsReturned;
      if (resultsReturned) {
        Object.assign(executionStats, {
          resultsReturned:
            typeof resultsReturned === 'string'
              ? parseInt(resultsReturned)
              : resultsReturned,
        });
      }
    }
    {
      const executionDuration =
        resp.explainMetrics.executionStats.executionDuration;
      if (executionDuration) {
        Object.assign(executionStats, {
          executionDuration:
            typeof executionDuration === 'string'
              ? parseInt(executionDuration)
              : executionDuration,
        });
      }
    }
    {
      const readOperations = resp.explainMetrics.executionStats.readOperations;
      if (readOperations) {
        Object.assign(executionStats, {
          readOperations:
            typeof readOperations === 'string'
              ? parseInt(readOperations)
              : readOperations,
        });
      }
    }
    {
      const debugStats = resp.explainMetrics.executionStats.debugStats;
      if (debugStats) {
        Object.assign(executionStats, {debugStats: decodeStruct(debugStats)});
      }
    }
    Object.assign(explainMetrics, {executionStats});
  }
  if (explainMetrics.planSummary || explainMetrics.executionStats) {
    return {explainMetrics};
  }
  return {};
}

const readTimeAndConsistencyError =
  'Read time and read consistency cannot both be specified.';

// Write function to check for readTime and readConsistency.
function throwOnReadTimeAndConsistency(options: RunQueryStreamOptions) {
  if (options.readTime && options.consistency) {
    throw new Error(readTimeAndConsistencyError);
  }
}

/**
 * A map of read consistency values to proto codes.
 *
 * @type {object}
 * @private
 */
const CONSISTENCY_PROTO_CODE: ConsistencyProtoCode = {
  eventual: 2,
  strong: 1,
};

/**
 * By default a DatastoreRequest is in the NOT_TRANSACTION state. If the
 * DatastoreRequest is a Transaction object, then initially it will be in
 * the NOT_STARTED state, but then the state will become IN_PROGRESS after the
 * transaction has started.
 */
export enum TransactionState {
  NOT_TRANSACTION,
  NOT_STARTED,
  IN_PROGRESS,
  EXPIRED,
}

/**
 * Handles request logic for Datastore API operations.
 *
 * Creates requests to the Datastore endpoint. Designed to be inherited by
 * the {@link Datastore} and {@link Transaction} classes.
 *
 * @class
 */
class DatastoreRequest {
  id: string | undefined | Uint8Array | null;
  requests_:
    | Entity
    | {
        mutations: Array<{}>;
      };
  requestCallbacks_:
    | Array<(err: Error | null, resp: Entity | null) => void>
    | Entity;
  datastore!: Datastore;
  protected state: TransactionState = TransactionState.NOT_TRANSACTION;
  [key: string]: Entity;

  /**
   * Format a user's input to mutation methods. This will create a deep clone of
   * the input, as well as allow users to pass an object in the format of an
   * entity.
   *
   * Both of the following formats can be supplied supported:
   *
   *     datastore.save({
   *       key: datastore.key('Kind'),
   *       data: { foo: 'bar' }
   *     }, (err) => {})
   *
   *     const entity = { foo: 'bar' }
   *     entity[datastore.KEY] = datastore.key('Kind')
   *     datastore.save(entity, (err) => {})
   *
   * @internal
   *
   * @see {@link https://github.com/GoogleCloudPlatform/google-cloud-node/issues/1803}
   *
   * @param {object} obj The user's input object.
   */
  static prepareEntityObject_(obj: Entity): PrepareEntityObjectResponse {
    const entityObject = extend(true, {}, obj);

    // Entity objects are also supported.
    if (obj[entity.KEY_SYMBOL]) {
      return {
        key: obj[entity.KEY_SYMBOL],
        data: entityObject,
      };
    }

    return entityObject;
  }

  /**
   * Generate IDs without creating entities.
   *
   * @param {Key} key The key object to complete.
   * @param {number|object} options Either the number of IDs to allocate or an
   *     options object for further customization of the request.
   * @param {number} options.allocations How many IDs to allocate.
   * @param {object} [options.gaxOptions] Request configuration options, outlined
   *     here: https://googleapis.github.io/gax-nodejs/global.html#CallOptions.
   * @param {function} callback The callback function.
   * @param {?error} callback.err An error returned while making this request
   * @param {array} callback.keys The generated IDs
   * @param {object} callback.apiResponse The full API response.
   *
   * @example
   * ```
   * const incompleteKey = datastore.key(['Company']);
   *
   * //-
   * // The following call will create 100 new IDs from the Company kind, which
   * // exists under the default namespace.
   * //-
   * datastore.allocateIds(incompleteKey, 100, (err, keys) => {});
   *
   * //-
   * // Or, if you're using a transaction object.
   * //-
   * const transaction = datastore.transaction();
   *
   * transaction.run((err) => {
   *   if (err) {
   *     // Error handling omitted.
   *   }
   *
   *   transaction.allocateIds(incompleteKey, 100, (err, keys) => {
   *     if (err) {
   *       // Error handling omitted.
   *     }
   *
   *     transaction.commit((err) => {
   *       if (!err) {
   *         // Transaction committed successfully.
   *       }
   *     });
   *   });
   * });
   *
   * //-
   * // You may prefer to create IDs from a non-default namespace by providing
   * an
   * // incomplete key with a namespace. Similar to the previous example, the
   * call
   * // below will create 100 new IDs, but from the Company kind that exists
   * under
   * // the "ns-test" namespace.
   * //-
   * const incompleteKey = datastore.key({
   *   namespace: 'ns-test',
   *   path: ['Company']
   * });
   *
   * function callback(err, keys, apiResponse) {}
   *
   * datastore.allocateIds(incompleteKey, 100, callback);
   *
   * //-
   * // Returns a Promise if callback is omitted.
   * //-
   * datastore.allocateIds(incompleteKey, 100).then((data) => {
   *   const keys = data[0];
   *   const apiResponse = data[1];
   * });
   * ```
   */
  allocateIds(
    key: entity.Key,
    options: AllocateIdsOptions | number,
  ): Promise<AllocateIdsResponse>;
  allocateIds(
    key: entity.Key,
    options: AllocateIdsOptions | number,
    callback: AllocateIdsCallback,
  ): void;
  allocateIds(
    key: entity.Key,
    options: AllocateIdsOptions | number,
    callback?: AllocateIdsCallback,
  ): void | Promise<AllocateIdsResponse> {
    if (entity.isKeyComplete(key)) {
      throw new Error('An incomplete key should be provided.');
    }
    options = typeof options === 'number' ? {allocations: options} : options;

    this.request_(
      {
        client: 'DatastoreClient',
        method: 'allocateIds',
        reqOpts: {
          keys: new Array(options.allocations).fill(entity.keyToKeyProto(key)),
        },
        gaxOpts: options.gaxOptions,
      },
      (err, resp) => {
        if (err) {
          callback!(err, null, resp!);
          return;
        }
        const keys = arrify(resp!.keys!).map(entity.keyFromKeyProto);
        callback!(null, keys, resp!);
      },
    );
  }

  /* This throws an error if the transaction has already expired.
   *
   */
  protected checkExpired() {
    if (this.state === TransactionState.EXPIRED) {
      throw Error(transactionExpiredError);
    }
  }

  /**
   * Retrieve the entities as a readable object stream.
   *
   * @throws {Error} If at least one Key object is not provided.
   * @throws {Error} If read time and read consistency cannot both be specified.
   *
   * @param {Key|Key[]} keys Datastore key object(s).
   * @param {object} [options] Optional configuration. See {@link Datastore#get}
   *     for a complete list of options.
   *
   * @example
   * ```
   * const keys = [
   *   datastore.key(['Company', 123]),
   *   datastore.key(['Product', 'Computer'])
   * ];
   *
   * datastore.createReadStream(keys)
   *   .on('error', (err) =>  {})
   *   .on('data', (entity) => {
   *     // entity is an entity object.
   *   })
   *   .on('end', () => {
   *     // All entities retrieved.
   *   });
   * ```
   */
  createReadStream(
    keys: Entities,
    options: CreateReadStreamOptions = {},
  ): Transform {
    keys = arrify(keys).map(entity.keyToKeyProto);
    if (keys.length === 0) {
      throw new Error('At least one Key object is required.');
    }
    this.checkExpired();
    throwOnReadTimeAndConsistency(options);
    const reqOpts = this.getRequestOptions(options);
    throwOnTransactionErrors(this, reqOpts);
    const makeRequest = (keys: entity.Key[] | KeyProto[]) => {
      Object.assign(reqOpts, {keys});
      this.request_(
        {
          client: 'DatastoreClient',
          method: 'lookup',
          reqOpts,
          gaxOpts: options.gaxOptions,
        },
        (err, resp) => {
          this.parseTransactionResponse(resp);
          if (err) {
            stream.destroy(err);
            return;
          }

          let entities: Entity[] = [];

          try {
            entities = entity.formatArray(
              resp!.found! as ResponseResult[],
              options.wrapNumbers,
            );
          } catch (err) {
            stream.destroy(err);
            return;
          }
          const nextKeys = (resp!.deferred || [])
            .map(entity.keyFromKeyProto)
            .map(entity.keyToKeyProto);

          split(entities, stream)
            .then(streamEnded => {
              if (streamEnded) {
                return;
              }

              if (nextKeys.length > 0) {
                makeRequest(nextKeys);
                return;
              }

              stream.push(null);
            })
            .catch(err => {
              throw err;
            });
        },
      );
    };

    const stream = streamEvents(new Transform({objectMode: true}));
    stream.once('reading', () => {
      makeRequest(keys);
    });
    return stream;
  }

  /**
   * Delete all entities identified with the specified key(s).
   *
   * @param {Key|Key[]} key Datastore key object(s).
   * @param {object} [gaxOptions] Request configuration options, outlined here:
   *     https://googleapis.github.io/gax-nodejs/global.html#CallOptions.
   * @param {function} callback The callback function.
   * @param {?error} callback.err An error returned while making this request
   * @param {object} callback.apiResponse The full API response.
   *
   * @example
   * ```
   * const key = datastore.key(['Company', 123]);
   * datastore.delete(key, (err, apiResp) => {});
   *
   * //-
   * // Or, if you're using a transaction object.
   * //-
   * const transaction = datastore.transaction();
   *
   * transaction.run((err) => {
   *   if (err) {
   *     // Error handling omitted.
   *   }
   *
   *   transaction.delete(key);
   *
   *   transaction.commit((err) => {
   *     if (!err) {
   *       // Transaction committed successfully.
   *     }
   *   });
   * });
   *
   * //-
   * // Delete multiple entities at once.
   * //-
   * datastore.delete([
   *   datastore.key(['Company', 123]),
   *   datastore.key(['Product', 'Computer'])
   * ], (err, apiResponse) => {});
   *
   * //-
   * // Returns a Promise if callback is omitted.
   * //-
   * datastore.delete().then((data) => {
   *   const apiResponse = data[0];
   * });
   * ```
   */
  delete(keys: Entities, gaxOptions?: CallOptions): Promise<DeleteResponse>;
  delete(keys: Entities, callback: DeleteCallback): void;
  delete(
    keys: Entities,
    gaxOptions: CallOptions,
    callback: DeleteCallback,
  ): void;
  delete(
    keys: entity.Key | entity.Key[],
    gaxOptionsOrCallback?: CallOptions | DeleteCallback,
    cb?: DeleteCallback,
  ): void | Promise<DeleteResponse> {
    const gaxOptions =
      typeof gaxOptionsOrCallback === 'object' ? gaxOptionsOrCallback : {};
    const callback =
      typeof gaxOptionsOrCallback === 'function' ? gaxOptionsOrCallback : cb!;

    const reqOpts = {
      mutations: arrify(keys).map(key => {
        return {
          delete: entity.keyToKeyProto(key),
        };
      }),
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } as any;

    if (this.id) {
      this.requests_.push(reqOpts);
      return;
    }

    this.request_(
      {
        client: 'DatastoreClient',
        method: 'commit',
        reqOpts,
        gaxOpts: gaxOptions,
      },
      callback,
    );
  }

  /**
   * Retrieve the entities identified with the specified key(s) in the current
   * transaction. Get operations require a valid key to retrieve the
   * key-identified entity from Datastore.
   *
   * @throws {Error} If at least one Key object is not provided.
   *
   * @param {Key|Key[]} keys Datastore key object(s).
   * @param {object} [options] Optional configuration.
   * @param {string} [options.consistency] Specify either `strong` or `eventual`.
   *     If not specified, default values are chosen by Datastore for the
   *     operation. Learn more about strong and eventual consistency
   *     [here](https://cloud.google.com/datastore/docs/articles/balancing-strong-and-eventual-consistency-with-google-cloud-datastore).
   * @param {object} [options.gaxOptions] Request configuration options, outlined
   *     here: https://googleapis.github.io/gax-nodejs/global.html#CallOptions.
   * @param {boolean | IntegerTypeCastOptions} [options.wrapNumbers=false]
   *     Wrap values of integerValue type in {@link Datastore#Int} objects.
   *     If a `boolean`, this will wrap values in {@link Datastore#Int} objects.
   *     If an `object`, this will return a value returned by
   *     `wrapNumbers.integerTypeCastFunction`.
   *     Please see {@link IntegerTypeCastOptions} for options descriptions.
   * @param {function} callback The callback function.
   * @param {?error} callback.err An error returned while making this request
   * @param {object|object[]} callback.entity The entity object(s) which match
   *     the provided keys.
   *
   * @example
   * ```
   * //-
   * // Get a single entity.
   * //-
   * const key = datastore.key(['Company', 123]);
   *
   * datastore.get(key, (err, entity) => {});
   *
   * //-
   * // Or, if you're using a transaction object.
   * //-
   * const transaction = datastore.transaction();
   *
   * transaction.run((err) => {
   *   if (err) {
   *     // Error handling omitted.
   *   }
   *
   *   transaction.get(key, (err, entity) => {
   *     if (err) {
   *       // Error handling omitted.
   *     }
   *
   *     transaction.commit((err) => {
   *       if (!err) {
   *         // Transaction committed successfully.
   *       }
   *     });
   *   });
   * });
   *
   * //-
   * // Get multiple entities at once with a callback.
   * //-
   * const keys = [
   *   datastore.key(['Company', 123]),
   *   datastore.key(['Product', 'Computer'])
   * ];
   *
   * datastore.get(keys, (err, entities) => {});
   *
   * //-
   * // Below is how to update the value of an entity with the help of the
   * // `save` method.
   * //-
   * datastore.get(key, (err, entity) => {
   *   if (err) {
   *     // Error handling omitted.
   *   }
   *
   *   entity.newValue = true;
   *
   *   datastore.save({
   *     key: key,
   *     data: entity
   *   }, (err) => {});
   * });
   *
   * //-
   * // Returns a Promise if callback is omitted.
   * //-
   * datastore.get(keys).then((data) => {
   *   const entities = data[0];
   * });
   * ```
   */
  get(
    keys: entity.Key | entity.Key[],
    options?: CreateReadStreamOptions,
  ): Promise<GetResponse>;
  get(keys: entity.Key | entity.Key[], callback: GetCallback): void;
  get(
    keys: entity.Key | entity.Key[],
    options: CreateReadStreamOptions,
    callback: GetCallback,
  ): void;
  get(
    keys: entity.Key | entity.Key[],
    optionsOrCallback?: CreateReadStreamOptions | GetCallback,
    cb?: GetCallback,
  ): void | Promise<GetResponse> {
    const options =
      typeof optionsOrCallback === 'object' && optionsOrCallback
        ? optionsOrCallback
        : {};
    const callback =
      typeof optionsOrCallback === 'function' ? optionsOrCallback : cb!;

    try {
      this.createReadStream(keys, options)
        .on('error', callback)
        .pipe(
          concat((results: Entity[]) => {
            const isSingleLookup = !Array.isArray(keys);
            callback(null, isSingleLookup ? results[0] : results);
          }),
        );
    } catch (err: any) {
      callback(err);
    }
  }

  /**
   * This function saves results from a successful beginTransaction call.
   *
   * @param {object} [response] The response from a call to
   * begin a transaction that completed successfully.
   *
   **/
  protected parseTransactionResponse(resp?: {
    transaction?: Uint8Array | string | undefined | null;
  }): void {
    if (resp && resp.transaction && Buffer.byteLength(resp.transaction) > 0) {
      this.id = resp!.transaction;
      this.state = TransactionState.IN_PROGRESS;
    }
  }

  /**
   * Datastore allows you to run aggregate queries by supplying aggregate fields
   * which will determine the type of aggregation that is performed.
   *
   * The query is run, and the results are returned in the second argument of
   * the callback provided.
   *
   * @param {AggregateQuery} query AggregateQuery object.
   * @param {RunQueryOptions} options Optional configuration
   * @param {function} [callback] The callback function. If omitted, a promise is
   * returned.
   *
   * @throws {Error} If read time and read consistency cannot both be specified.
   *
   **/
  runAggregationQuery(
    query: AggregateQuery,
    options?: RunQueryOptions,
  ): Promise<RunQueryResponse>;
  runAggregationQuery(
    query: AggregateQuery,
    options: RunQueryOptions,
    callback: RunAggregationQueryCallback,
  ): void;
  runAggregationQuery(
    query: AggregateQuery,
    callback: RunAggregationQueryCallback,
  ): void;
  runAggregationQuery(
    query: AggregateQuery,
    optionsOrCallback?: RunQueryOptions | RunAggregationQueryCallback,
    cb?: RequestCallback,
  ): void | Promise<RunQueryResponse> {
    const options =
      typeof optionsOrCallback === 'object' ? optionsOrCallback : {};
    const callback =
      typeof optionsOrCallback === 'function' ? optionsOrCallback : cb!;

    if (this.state === TransactionState.EXPIRED) {
      callback(new Error(transactionExpiredError));
      return;
    }
    if (options.readTime && options.consistency) {
      callback(new Error(readTimeAndConsistencyError));
      return;
    }
    query.query = extend(true, new Query(), query.query);
    let queryProto: QueryProto;
    try {
      queryProto = entity.queryToQueryProto(query.query);
    } catch (e) {
      // using setImmediate here to make sure this doesn't throw a
      // synchronous error
      setImmediate(callback, e as Error);
      return;
    }
    let sharedQueryOpts;
    try {
      sharedQueryOpts = this.getQueryOptions(query.query, options);
      throwOnTransactionErrors(this, sharedQueryOpts);
    } catch (error: any) {
      callback(error);
      return;
    }
    const aggregationQueryOptions: AggregationQueryOptions = {
      nestedQuery: queryProto,
      aggregations: query.toProto(),
    };
    const reqOpts: RunAggregationQueryRequest = Object.assign(sharedQueryOpts, {
      aggregationQuery: aggregationQueryOptions,
    });
    this.request_(
      {
        client: 'DatastoreClient',
        method: 'runAggregationQuery',
        reqOpts,
        gaxOpts: options.gaxOptions,
      },
      (err, res) => {
        const info = getInfoFromStats(res);
        this.parseTransactionResponse(res);
        if (res && res.batch) {
          const results = res.batch.aggregationResults;
          const finalResults = results
            .map(
              (aggregationResult: any) => aggregationResult.aggregateProperties,
            )
            .map((aggregateProperties: any) =>
              Object.fromEntries(
                new Map(
                  Object.keys(aggregateProperties).map(key => [
                    key,
                    entity.decodeValueProto(aggregateProperties[key]),
                  ]),
                ),
              ),
            );
          callback(err, finalResults, info);
        } else {
          callback(err, [], info);
        }
      },
    );
  }

  /**
   * Datastore allows you to query entities by kind, filter them by property
   * filters, and sort them by a property name. Projection and pagination are
   * also supported.
   *
   * The query is run, and the results are returned as the second argument to
   * your callback. A third argument may also exist, which is a query object
   * that uses the end cursor from the previous query as the starting cursor for
   * the next query. You can pass that object back to this method to see if more
   * results exist.
   * @param {Query} query A Query object
   * @param {object} [options] Optional configuration.
   * @param {string} [options.consistency] Specify either `strong` or `eventual`.
   *     If not specified, default values are chosen by Datastore for the
   *     operation. Learn more about strong and eventual consistency
   *     [here](https://cloud.google.com/datastore/docs/articles/balancing-strong-and-eventual-consistency-with-google-cloud-datastore).
   * @param {object} [options.gaxOptions] Request configuration options, outlined
   *     here: https://googleapis.github.io/gax-nodejs/global.html#CallOptions.
   * @param {boolean | IntegerTypeCastOptions} [options.wrapNumbers=false]
   *     Wrap values of integerValue type in {@link Datastore#Int} objects.
   *     If a `boolean`, this will wrap values in {@link Datastore#Int} objects.
   *     If an `object`, this will return a value returned by
   *     `wrapNumbers.integerTypeCastFunction`.
   *     Please see {@link IntegerTypeCastOptions} for options descriptions.
   * @param {function} [callback] The callback function. If omitted, a readable
   *     stream instance is returned.
   * @param {?error} callback.err An error returned while making this request
   * @param {object[]} callback.entities A list of entities.
   * @param {object} callback.info An object useful for pagination.
   * @param {?string} callback.info.endCursor Use this in a follow-up query to
   *     begin from where these results ended.
   * @param {string} callback.info.moreResults Datastore responds with one of:
   *
   *     - {@link Datastore#MORE_RESULTS_AFTER_LIMIT}: There *may* be more
   *       results after the specified limit.
   *     - {@link Datastore#MORE_RESULTS_AFTER_CURSOR}: There *may* be more
   *       results after the specified end cursor.
   *     - {@link Datastore#NO_MORE_RESULTS}: There are no more results.
   *
   * @example
   * ```
   * //-
   * // Where you see `transaction`, assume this is the context that's relevant
   * to
   * // your use, whether that be a Datastore or a Transaction object.
   * //-
   * const query = datastore.createQuery('Lion');
   *
   * datastore.runQuery(query, (err, entities, info) => {
   *   // entities = An array of records.
   *
   *   // Access the Key object for an entity.
   *   const firstEntityKey = entities[0][datastore.KEY];
   * });
   *
   * //-
   * // Or, if you're using a transaction object.
   * //-
   * const transaction = datastore.transaction();
   *
   * transaction.run((err) => {
   *   if (err) {
   *     // Error handling omitted.
   *   }
   *
   *   transaction.runQuery(query, (err, entities) => {
   *     if (err) {
   *       // Error handling omitted.
   *     }
   *
   *     transaction.commit((err) => {
   *       if (!err) {
   *         // Transaction committed successfully.
   *       }
   *     });
   *   });
   * });
   *
   * //-
   * // A keys-only query returns just the keys of the result entities instead
   * of
   * // the entities themselves, at lower latency and cost.
   * //-
   * const keysOnlyQuery = datastore.createQuery('Lion').select('__key__');
   *
   * datastore.runQuery(keysOnlyQuery, (err, entities) => {
   *   const keys = entities.map((entity) => {
   *     return entity[datastore.KEY];
   *   });
   * });
   *
   * //-
   * // Returns a Promise if callback is omitted.
   * //-
   * datastore.runQuery(query).then((data) => {
   *   const entities = data[0];
   * });
   * ```
   */
  runQuery(query: Query, options?: RunQueryOptions): Promise<RunQueryResponse>;
  runQuery(
    query: Query,
    options: RunQueryOptions,
    callback: RunQueryCallback,
  ): void;
  runQuery(query: Query, callback: RunQueryCallback): void;
  runQuery(
    query: Query,
    optionsOrCallback?: RunQueryOptions | RunQueryCallback,
    cb?: RunQueryCallback,
  ): void | Promise<RunQueryResponse> {
    const options =
      typeof optionsOrCallback === 'object' ? optionsOrCallback : {};
    const callback =
      typeof optionsOrCallback === 'function' ? optionsOrCallback : cb!;

    let info: RunQueryInfo;

    try {
      this.runQueryStream(query, options)
        .on('error', callback)
        .on('info', info_ => {
          info = info_;
        })
        .pipe(
          concat((results: Entity[]) => {
            callback(null, results, info);
          }),
        );
    } catch (err: any) {
      callback(err);
    }
  }

  /**
   * Get a list of entities as a readable object stream.
   *
   * See {@link Datastore#runQuery} for a list of all available options.
   *
   * @param {Query} query A Query object
   * @param {object} [options] Optional configuration.
   * @param {object} [options.gaxOptions] Request configuration options, outlined
   *     here: https://googleapis.github.io/gax-nodejs/global.html#CallOptions.
   *
   * @throws {Error} If read time and read consistency cannot both be specified.
   *
   * @example
   * ```
   * datastore.runQueryStream(query)
   *   .on('error', console.error)
   *   .on('data', (entity) => {
   *     // Access the Key object for this entity.
   *     const key = entity[datastore.KEY];
   *   })
   *   .on('info', (info) => {})
   *   .on('end', () => {
   *     // All entities retrieved.
   *   });
   *
   * //-
   * // If you anticipate many results, you can end a stream early to prevent
   * // unnecessary processing and API requests.
   * //-
   * datastore.runQueryStream(query)
   *   .on('data', (entity) => {
   *     this.end();
   *   });
   * ```
   */
  runQueryStream(query: Query, options: RunQueryStreamOptions = {}): Transform {
    this.checkExpired();
    throwOnReadTimeAndConsistency(options);
    query = extend(true, new Query(), query);
    const sharedQueryOpts = this.getQueryOptions(query, options);
    throwOnTransactionErrors(this, sharedQueryOpts);
    const makeRequest = (query: Query) => {
      let queryProto: QueryProto;
      try {
        queryProto = entity.queryToQueryProto(query);
      } catch (e) {
        // using setImmediate here to make sure this doesn't throw a
        // synchronous error
        setImmediate(onResultSet, e as Error);
        return;
      }

      const reqOpts: RequestOptions = sharedQueryOpts;
      reqOpts.query = queryProto;
      this.request_(
        {
          client: 'DatastoreClient',
          method: 'runQuery',
          reqOpts,
          gaxOpts: options.gaxOptions,
        },
        onResultSet,
      );
    };

    const onResultSet = (err?: Error | null, resp?: Entity) => {
      this.parseTransactionResponse(resp);
      if (err) {
        stream.destroy(err);
        return;
      }

      if (!resp.batch) {
        // If there are no results then send any stats back and end the stream.
        stream.emit('info', getInfoFromStats(resp));
        stream.push(null);
        return;
      }

      const info = Object.assign(getInfoFromStats(resp), {
        moreResults: resp.batch.moreResults,
      });

      if (resp.batch.endCursor) {
        info.endCursor = resp.batch.endCursor.toString('base64');
      }

      let entities: Entity[] = [];

      if (resp.batch.entityResults) {
        try {
          entities = entity.formatArray(
            resp.batch.entityResults,
            options.wrapNumbers,
          );
        } catch (err) {
          stream.destroy(err);
          return;
        }
      }

      // Emit each result right away, then get the rest if necessary.
      split(entities, stream)
        .then(streamEnded => {
          if (streamEnded) {
            return;
          }

          if (resp.batch.moreResults !== 'NOT_FINISHED') {
            stream.emit('info', info);
            stream.push(null);
            return;
          }

          // The query is "NOT_FINISHED". Get the rest of the results.
          const offset = query.offsetVal === -1 ? 0 : query.offsetVal;

          query
            .start(info.endCursor!)
            .offset(offset - resp.batch.skippedResults);

          const limit = query.limitVal;
          if (limit && limit > -1) {
            query.limit(limit - resp.batch.entityResults.length);
          }

          makeRequest(query);
        })
        .catch(err => {
          throw err;
        });
    };

    const stream = streamEvents(new Transform({objectMode: true}));
    stream.once('reading', () => {
      makeRequest(query);
    });
    return stream;
  }

  /**
   * Gets request options from a RunQueryStream options configuration
   *
   * @param {RunQueryStreamOptions} [options] The RunQueryStream options configuration
   */
  private getRequestOptions(
    options: RunQueryStreamOptions,
  ): SharedQueryOptions {
    const sharedQueryOpts = {} as SharedQueryOptions;
    if (isTransaction(this)) {
      if (this.state === TransactionState.NOT_STARTED) {
        if (sharedQueryOpts.readOptions === undefined) {
          sharedQueryOpts.readOptions = {};
        }
        sharedQueryOpts.readOptions.newTransaction = getTransactionRequest(
          this,
          {},
        );
        sharedQueryOpts.readOptions.consistencyType = 'newTransaction';
      }
    }
    if (options.consistency) {
      const code = CONSISTENCY_PROTO_CODE[options.consistency.toLowerCase()];
      if (sharedQueryOpts.readOptions === undefined) {
        sharedQueryOpts.readOptions = {};
      }
      sharedQueryOpts.readOptions.readConsistency = code;
    }
    if (options.readTime) {
      if (sharedQueryOpts.readOptions === undefined) {
        sharedQueryOpts.readOptions = {};
      }
      const readTime = options.readTime;
      const seconds = readTime / 1000;
      sharedQueryOpts.readOptions.readTime = {
        seconds: Math.floor(seconds),
      };
    }
    return sharedQueryOpts;
  }

  /**
   * Gets request options from a RunQueryStream options configuration
   *
   * @param {Query} [query] A Query object
   * @param {RunQueryStreamOptions} [options] The RunQueryStream options configuration
   */
  private getQueryOptions(
    query: Query,
    options: RunQueryStreamOptions = {},
  ): SharedQueryOptions {
    const sharedQueryOpts = this.getRequestOptions(options);
    if (options.explainOptions) {
      sharedQueryOpts.explainOptions = options.explainOptions;
    }
    if (query.namespace) {
      sharedQueryOpts.partitionId = {
        namespaceId: query.namespace,
      };
    }
    return sharedQueryOpts;
  }

  /**
   * Merge the specified object(s). If a key is incomplete, its associated object
   * is inserted and the original Key object is updated to contain the generated ID.
   * For example, if you provide an incomplete key (one without an ID),
   * the request will create a new entity and have its ID automatically assigned.
   * If you provide a complete key, the entity will be get the data from datastore
   * and merge with the data specified.
   * By default, all properties are indexed. To prevent a property from being
   * included in *all* indexes, you must supply an `excludeFromIndexes` array.
   *
   * Maps to {@link Datastore#save}, forcing the method to be `upsert`.
   *
   * @param {object|object[]} entities Datastore key object(s).
   * @param {Key} entities.key Datastore key object.
   * @param {string[]} [entities.excludeFromIndexes] Exclude properties from
   *     indexing using a simple JSON path notation. See the examples in
   *     {@link Datastore#save} to see how to target properties at different
   *     levels of nesting within your entity.
   * @param {object} entities.data Data to merge to the same for provided key.
   * @param {function} callback The callback function.
   * @param {?error} callback.err An error returned while making this request
   * @param {object} callback.apiResponse The full API response.
   */
  merge(entities: Entities): Promise<CommitResponse>;
  merge(entities: Entities, callback: SaveCallback): void;
  merge(
    entities: Entities,
    callback?: SaveCallback,
  ): void | Promise<CommitResponse> {
    const transaction = this.datastore.transaction();
    transaction.run(async (err: any) => {
      if (err) {
        try {
          await transaction.rollback();
        } catch (error) {
          // Provide the error & API response from the failed run to the user.
          // Even a failed rollback should be transparent.
          // RE: https://github.com/GoogleCloudPlatform/gcloud-node/pull/1369#discussion_r66833976
        }
        callback!(err);
        return;
      }
      try {
        await Promise.all(
          arrify(entities).map(async (objEntity: Entity) => {
            const obj: Entity =
              DatastoreRequest.prepareEntityObject_(objEntity);
            const [data] = await transaction.get(obj.key);
            obj.method = 'upsert';
            obj.data = Object.assign({}, data, obj.data);
            transaction.save(obj);
          }),
        );

        const [response] = await transaction.commit();
        callback!(null, response);
      } catch (err) {
        try {
          await transaction.rollback();
        } catch (error) {
          // Provide the error & API response from the failed commit to the user.
          // Even a failed rollback should be transparent.
          // RE: https://github.com/GoogleCloudPlatform/gcloud-node/pull/1369#discussion_r66833976
        }
        callback!(err as Error);
      }
    });
  }

  /**
   * Builds a request and sends it to the Gapic Layer.
   *
   * @param {object} config Configuration object.
   * @param {function} callback The callback function.
   *
   * @private
   */
  prepareGaxRequest_(config: RequestConfig, callback: Function): void {
    const datastore = this.datastore;

    const isTransaction = this.id ? true : false;
    const method = config.method;
    const reqOpts = extend(true, {}, config.reqOpts);

    // Set properties to indicate if we're in a transaction or not.
    if (method === 'commit') {
      if (isTransaction) {
        reqOpts.mode = 'TRANSACTIONAL';
        reqOpts.transaction = this.id;
      } else {
        reqOpts.mode = 'NON_TRANSACTIONAL';
      }
    }

    if (datastore.options && datastore.options.databaseId) {
      reqOpts.databaseId = datastore.options.databaseId;
    }

    if (method === 'rollback') {
      reqOpts.transaction = this.id;
    }
    throwOnTransactionErrors(this, reqOpts);
    if (
      isTransaction &&
      (method === 'lookup' ||
        method === 'runQuery' ||
        method === 'runAggregationQuery')
    ) {
      if (reqOpts.readOptions) {
        Object.assign(reqOpts.readOptions, {transaction: this.id});
      } else {
        reqOpts.readOptions = {
          transaction: this.id,
        };
      }
    }

    datastore.auth.getProjectId((err, projectId) => {
      if (err) {
        callback!(err);
        return;
      }
      const clientName = config.client;
      if (!datastore.clients_.has(clientName)) {
        datastore.clients_.set(
          clientName,
          new gapic.v1[clientName](datastore.options),
        );
      }
      const gaxClient = datastore.clients_.get(clientName);
      reqOpts.projectId = projectId!;
      const gaxOpts = extend(true, {}, config.gaxOpts, {
        headers: {
          'google-cloud-resource-prefix': `projects/${projectId}`,
        },
      });
      const requestFn = gaxClient![method].bind(gaxClient, reqOpts, gaxOpts);
      callback(null, requestFn);
    });
  }

  /**
   * Make a request to the API endpoint. Properties to indicate a transactional
   * or non-transactional operation are added automatically.
   *
   * @param {object} config Configuration object.
   * @param {object} config.gaxOpts GAX options.
   * @param {string} config.client The name of the gax client.
   * @param {function} config.method The gax method to call.
   * @param {object} config.reqOpts Request options.
   * @param {function} callback The callback function.
   *
   * @private
   */
  request_(config: RequestConfig, callback: RequestCallback): void;
  request_(config: RequestConfig, callback: RequestCallback): void {
    this.prepareGaxRequest_(config, (err: Error, requestFn: Function) => {
      if (err) {
        callback(err);
        return;
      }
      requestFn(callback);
    });
  }

  /**
   * Make a request as a stream.
   *
   * @param {object} config Configuration object.
   * @param {object} config.gaxOpts GAX options.
   * @param {string} config.client The name of the gax client.
   * @param {string} config.method The gax method to call.
   * @param {object} config.reqOpts Request options.
   */
  requestStream_(config: RequestConfig): AbortableDuplex {
    let gaxStream: CancellableStream;
    const stream = streamEvents(new PassThrough({objectMode: true}));

    stream.abort = () => {
      if (gaxStream && gaxStream.cancel) {
        gaxStream.cancel();
      }
    };

    stream.once('reading', () => {
      this.prepareGaxRequest_(config, (err: Error, requestFn: Function) => {
        if (err) {
          stream.destroy(err);
          return;
        }

        gaxStream = requestFn();
        gaxStream
          .on('error', stream.destroy.bind(stream))
          .on('response', stream.emit.bind(stream, 'response'))
          .pipe(stream);
      });
    });

    return stream as AbortableDuplex;
  }
}

/**
 * Check to see if a request is a Transaction
 *
 * @param {DatastoreRequest} request The Datastore request object
 *
 */
function isTransaction(request: DatastoreRequest): request is Transaction {
  return request instanceof Transaction;
}

/**
 * Throw an error if read options are not properly specified.
 *
 * @param {DatastoreRequest} request The Datastore request object
 * @param {SharedQueryOptions} options The Query options
 *
 */
function throwOnTransactionErrors(
  request: DatastoreRequest,
  options: SharedQueryOptions,
) {
  const isTransaction = request.id ? true : false;
  if (
    isTransaction ||
    (options.readOptions && options.readOptions.newTransaction)
  ) {
    if (options.readOptions && options.readOptions.readConsistency) {
      throw new Error('Read consistency cannot be specified in a transaction.');
    }
    if (options.readOptions && options.readOptions.readTime) {
      throw new Error('Read time cannot be specified in a transaction.');
    }
  }
}

/**
 * This function gets transaction request options used for defining a
 * request to create a new transaction on the server.
 *
 * @param {Transaction} transaction The transaction for which the request will be made.
 * @param {RunOptions} options Custom options that will be used to create the request.
 */
export function getTransactionRequest(
  transaction: Transaction,
  options: RunOptions,
): TransactionRequestOptions {
  // If transactionOptions are provide then they will be used.
  // Otherwise, options passed into this function are used and when absent
  // options that exist on Transaction are used.
  return options.transactionOptions // If transactionOptions is specified:
    ? options.transactionOptions.readOnly // Use readOnly on transactionOptions
      ? {readOnly: {}}
      : options.transactionOptions.id // Use retry transaction if specified:
        ? {readWrite: {previousTransaction: options.transactionOptions.id}}
        : {}
    : options.readOnly || transaction.readOnly // If transactionOptions not set:
      ? {readOnly: {}} // Create a readOnly transaction if readOnly option set
      : options.transactionId || transaction.id
        ? {
            // Create readWrite transaction with a retry transaction set
            readWrite: {
              previousTransaction: options.transactionId || transaction.id,
            },
          }
        : {}; // Request will be readWrite with no retry transaction set;
}

export interface ConsistencyProtoCode {
  [key: string]: number;
}
export type AllocateIdsResponse = [
  entity.Key[],
  google.datastore.v1.IAllocateIdsResponse,
];
export interface AllocateIdsCallback {
  (
    a: Error | null,
    b: entity.Key[] | null,
    c: google.datastore.v1.IAllocateIdsResponse,
  ): void;
}
export interface AllocateIdsOptions {
  allocations?: number;
  gaxOptions?: CallOptions;
}
export type CreateReadStreamOptions = RunQueryOptions;
export interface GetCallback {
  (err?: Error | null, entity?: Entities): void;
}
export type GetResponse = [Entities];
export interface Mutation {
  [key: string]: EntityProto;
}
export interface PrepareEntityObject {
  [key: string]: google.datastore.v1.Key | undefined;
}
export interface PrepareEntityObjectResponse {
  key?: entity.Key;
  data?: SaveDataValue;
  excludeFromIndexes?: string[];
  excludeLargeProperties?: boolean;
  method?: string;
}
export interface RequestCallback {
  (
    a?: Error | null,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    b?: any,
  ): void;
}
export interface RunAggregationQueryCallback {
  (
    a?: Error | null,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    b?: any,
    c?: RunQueryInfo,
  ): void;
}
export interface RequestConfig {
  client: string;
  gaxOpts?: CallOptions;
  method: string;
  prepared?: boolean;
  reqOpts?: RequestOptions;
}
export interface SharedQueryOptions {
  databaseId?: string;
  explainOptions?: ExplainOptions;
  projectId?: string;
  partitionId?: google.datastore.v1.IPartitionId | null;
  readOptions?: {
    readConsistency?: number;
    transaction?: string | Uint8Array | null;
    readTime?: ITimestamp;
    newTransaction?: TransactionRequestOptions;
    consistencyType?:
      | 'readConsistency'
      | 'transaction'
      | 'newTransaction'
      | 'readTime';
  };
}
export interface RequestOptions extends SharedQueryOptions {
  mutations?: google.datastore.v1.IMutation[];
  keys?: Entity;
  transactionOptions?: TransactionRequestOptions | null;
  transaction?: string | null | Uint8Array;
  mode?: string;
  query?: QueryProto;
  filter?: string;
  indexId?: string;
  entityFilter?: google.datastore.admin.v1.IEntityFilter;
}
export interface RunAggregationQueryRequest extends SharedQueryOptions {
  aggregationQuery: AggregationQueryOptions;
}
export interface AggregationQueryOptions {
  nestedQuery: QueryProto;
  aggregations: Array<any>;
}
export type RunQueryStreamOptions = RunQueryOptions;
export interface CommitCallback {
  (err?: Error | null, resp?: google.datastore.v1.ICommitResponse): void;
}
export type CommitResponse = [google.datastore.v1.ICommitResponse];
export type SaveCallback = CommitCallback;
export type SaveResponse = CommitResponse;
export type DeleteCallback = CommitCallback;
export type DeleteResponse = CommitResponse;

/*! Developer Documentation
 *
 * All async methods (except for streams) will return a Promise in the event
 * that a callback is omitted.
 */
promisifyAll(DatastoreRequest, {
  exclude: ['checkExpired', 'getQueryOptions', 'getRequestOptions'],
});

/**
 * Reference to the {@link DatastoreRequest} class.
 * @name module:@google-cloud/datastore.DatastoreRequest
 * @see DatastoreRequest
 */
export {DatastoreRequest};
