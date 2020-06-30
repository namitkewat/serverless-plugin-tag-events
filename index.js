'use strict';


let allowedResources = [
  "AWS::Events::Rule",
  "AWS::SNS::Topic"
];

function isEquivalent(a, b) {
  var aProps = Object.keys(a);
  var bProps = Object.keys(b);

  if (aProps.length != bProps.length) {
    return false;
  }

  for (var i = 0; i < aProps.length; i++) {
    var propName = aProps[i];

    if (a[propName] !== b[propName]) {
      return false;
    }
  }
  return true;
}

function ensureCleanedTagging(tagArn, provider, service, newTags, logger) {
  let queryParams = {};
  let ArnFormat = ['SNS'];
  if (ArnFormat.includes(service)) {
    queryParams["ResourceArn"] = tagArn;
  } else {
    queryParams["ResourceARN"] = tagArn;
  }

  logger(`running ensureCleanedTagging for: ${tagArn}`);

  return new Promise(function (resolve, reject) {
    provider.request(service,
      'listTagsForResource',
      queryParams).then((listTagResp) => {
        if (listTagResp && listTagResp.Tags.length > 0) {
          let newTagKeys = Object.keys(newTags);

          let invalidTags = [];
          let oldTagObj = {};

          listTagResp.Tags.forEach(tag => {
            oldTagObj[tag.Key] = tag.Value;
            if (!newTagKeys.includes(tag.Key)) {
              invalidTags.push(tag.Key)
            }
          });

          if (invalidTags.length > 0) {
            logger(`Removing ${JSON.stringify(invalidTags)} tags from: ${tagArn}`);

            // Remove Old tags
            provider.request(service,
              'untagResource',
              Object.assign({}, queryParams, { TagKeys: invalidTags })
            ).then((tagRemovalResp) => {

              logger(`Applying new/updated tags after removing of invalid tags from: ${tagArn}`);

              // Apply new tags
              provider.request(service,
                'tagResource',
                Object.assign({}, queryParams, {
                  Tags: Object.keys(newTags).map(k => ({ Key: k, Value: newTags[k] }))
                })
              ).then((tagUpdateResp) => {
                logger(`Resource tagging done for : ${tagArn}`);
                resolve(tagUpdateResp);
              });

            });

          } else {
            logger(`No invalid tags exists for: ${tagArn}`);

            if (isEquivalent(oldTagObj, newTags)) {
              logger(`Old & New tags are equal for: ${tagArn} hence skipping the tagging`);
              resolve();
            } else {
              logger(`Applying new/updated tags for: ${tagArn}`);

              // Apply new tags
              provider.request(service,
                'tagResource',
                Object.assign({}, queryParams,
                  {
                    Tags: Object.keys(newTags).map(k => ({ Key: k, Value: newTags[k] }))
                  })
              ).then((tagUpdateResp) => {
                logger(`Resource tagging done for : ${tagArn}`);
                resolve(tagUpdateResp);
              });

            }
          }
        } else {
          logger(`No Old tags exists for: ${tagArn}`);

          // Apply new tags
          provider.request(service,
            'tagResource',
            Object.assign({}, queryParams, {
              Tags: Object.keys(newTags).map(k => ({ Key: k, Value: newTags[k] }))
            })
          ).then((tagUpdateResp) => {
            logger(`Resource tagging done for : ${tagArn}`);
            resolve(tagUpdateResp);
          });
        }
      });
  });
}

class ServerlessPlugin {
  constructor(serverless, options) {
    this._serverless = serverless;
    this._provider = serverless.getProvider('aws');
    this._log = msg => { options.verbose && serverless.cli.log(msg); };

    this.hooks = {
      'after:aws:deploy:deploy:updateStack': this.afterDeployStack.bind(this),
    };
  }

  afterDeployStack() {
    let self = this;

    self._serverless.cli.log("Tagging start...");
    const stackName = self._provider.naming.getStackName();
    self._log(`Stack name ${stackName}`);

    let topics = [];
    let schedules = [];

    /* Get the topic tags from the configuration */
    self._serverless.service.getAllFunctions().forEach(functionName => {
      const functionObj = self._serverless.service.getFunction(functionName);
      let scheduleNumberInFunction = 0;

      if (!("events" in functionObj)) {
        return;
      }
      functionObj.events.forEach(event => {
        if (event.sns) {
          let topicArn;
          let topicName;
          let tags;
          let topicLogicalId;
          if (typeof event.sns === 'object') {
            if (event.sns.arn) {
              topicArn = event.sns.arn;
              const splitArn = topicArn.split(':');
              topicName = splitArn[splitArn.length - 1];
              topicName = event.sns.topicName || topicName;
            } else {
              topicName = event.sns.topicName;
            }
            tags = Object.assign({}, self._serverless.service.provider.tags, event.sns.tags);
            topicLogicalId = self._provider.naming.getTopicLogicalId(topicName)
            topics.push({ "logicalId": topicLogicalId, 'tags': tags });
          } else if (typeof event.sns === 'string') {
            if (event.sns.indexOf('arn:') === 0) {
              topicArn = event.sns;
              const splitArn = topicArn.split(':');
              topicName = splitArn[splitArn.length - 1];
            } else {
              topicName = event.sns;
            }
            tags = Object.assign({}, self._serverless.service.provider.tags);
            topicLogicalId = self._provider.naming.getTopicLogicalId(topicName)
            topics.push({ "logicalId": topicLogicalId, 'tags': tags });
          }
        } else if (event.schedule) {
          scheduleNumberInFunction++;

          let tags = Object.assign({}, self._serverless.service.provider.tags, event.schedule.tags);
          let scheduleLogicalId = self._provider.naming.getScheduleLogicalId(
            functionName,
            scheduleNumberInFunction
          );

          schedules.push({ "logicalId": scheduleLogicalId, 'tags': tags });

        } else {
          return;
        }

      });

      self._log(`${topics.length} topics found for tagging in serverless conf`);
      self._log(`${schedules.length} schedules found for tagging in serverless conf`);

    });

    /* Update tags for deployed resources */
    return self._provider
      .request('CloudFormation', 'describeStackResources', { StackName: stackName })
      .then(result => {
        return new Promise(function (resolve, reject) {
          if (result) {
            let partition = null;
            let region = null;
            let accountId = null;

            let promiseStack = [];

            // Tagging common  - started
            let AWSObjs = result.StackResources.filter(a => { return allowedResources.includes(a.ResourceType) });
            self._log(`${AWSObjs.length} resources found into AWS for which tagging will be checked`);

            AWSObjs.forEach(AWSObj => {
              let awsObj = undefined;
              let tagArn = undefined;
              let service = undefined;

              if (!partition || !region || !accountId) {
                let stackIdSplit = AWSObj.StackId.split(":");
                partition = stackIdSplit[1];
                region = stackIdSplit[3];
                accountId = stackIdSplit[4];
              }

              if (AWSObj.ResourceType == "AWS::SNS::Topic") {
                awsObj = topics.find(t => { return t.logicalId == AWSObj.LogicalResourceId });
                tagArn = AWSObj.PhysicalResourceId;
                service = "SNS";
              } else if (AWSObj.ResourceType == "AWS::Events::Rule") {
                awsObj = schedules.find(t => { return t.logicalId == AWSObj.LogicalResourceId });
                tagArn = `arn:${partition}:events:${region}:${accountId}:rule/${AWSObj.PhysicalResourceId}`;
                service = "EventBridge";
              }

              if (tagArn && service) {
                if (awsObj == undefined || Object.keys(awsObj.tags).length == 0) {
                  self._log(`Not tag found for ${tagArn}, hence performing cleaning of old tags(if exists)`);
                  promiseStack.push(ensureCleanedTagging(tagArn, self._provider, service, {}, self._log));
                } else {
                  self._log(`Performing tagging on: ${tagArn}`);
                  promiseStack.push(ensureCleanedTagging(tagArn, self._provider, service, awsObj.tags, self._log));
                }
              }
            });

            Promise.all(promiseStack).then(resp => {
              self._serverless.cli.log("Tagging finished...");
              resolve();
            });
            // Tagging common  - completed
          } else {
            self._serverless.cli.log("Tagging finished...");
            resolve();
          }

        });
      });

  }
}

module.exports = ServerlessPlugin;
