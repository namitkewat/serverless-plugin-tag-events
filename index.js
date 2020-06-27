'use strict';

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
  return new Promise(function (resolve, reject) {
    provider.request(service, 'listTagsForResource',
      {
        ResourceARN: tagArn
      }).then(oldTagResp => {
        if (oldTagResp) {
          let newTagKeys = Object.keys(newTags);
          let invalidTags = oldTagResp.Tags.map(tag => { return tag.Key }).filter(key => { return !newTagKeys.includes(key) });

          if (invalidTags.length > 0) {
            logger(`Removing ${JSON.stringify(invalidTags)} tags from rule: ${tagArn}`);

            // Remove Old tags
            provider.request(service, 'untagResource',
              {
                ResourceARN: tagArn,
                TagKeys: invalidTags
              }).then(tagRemovalResp => {
                logger(`Applying new/updated tags after removing of invalid tags from rule: ${tagArn}`);

                // Apply new tags
                provider.request(service, 'tagResource',
                  {
                    ResourceARN: tagArn,
                    Tags: Object.keys(newTags).map(k => ({ Key: k, Value: newTags[k] }))
                  }).then(tagUpdateResp => {
                    resolve(tagUpdateResp);
                  });
              });
          } else {
            logger(`No invalid tags exists for rule: ${tagArn}`);

            let oldTagObj = {};
            oldTagResp.Tags.forEach(tag => {
              oldTagObj[tag.Key] = tag.Value
            });

            if (isEquivalent(oldTagObj, newTags)) {
              logger(`Old & New tags are equal for rule: ${tagArn} hence skipping the tagging`);
              resolve();
            } else {
              logger(`Applying new/updated tags for rule: ${tagArn}`);
              // Apply new tags
              provider.request(service, 'tagResource',
                {
                  ResourceARN: tagArn,
                  Tags: Object.keys(newTags).map(k => ({ Key: k, Value: newTags[k] }))
                }).then(tagUpdateResp => {
                  resolve(tagUpdateResp);
                });
            }
          }
        } else {
          logger(`No Old tags exists for rule: ${tagArn}`);

          // Apply new tags
          this._provider.request(service, 'tagResource',
            {
              ResourceARN: tagArn,
              Tags: Object.keys(newTags).map(k => ({ Key: k, Value: newTags[k] }))
            }).then(tagUpdateResp => {
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
    this._serverless.cli.log("SNS tagging start...");
    const stackName = this._provider.naming.getStackName();
    this._log(`Stack name ${stackName}`);

    let topics = [];
    let schedules = [];

    /* Get the topic tags from the configuration */
    this._serverless.service.getAllFunctions().forEach(functionName => {
      const functionObj = this._serverless.service.getFunction(functionName);
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
            tags = Object.assign({}, this._serverless.service.provider.tags, event.sns.tags);
            topicLogicalId = this._provider.naming.getTopicLogicalId(topicName)
            topics.push({ "name": topicLogicalId, 'tags': tags });
          } else if (typeof event.sns === 'string') {
            if (event.sns.indexOf('arn:') === 0) {
              topicArn = event.sns;
              const splitArn = topicArn.split(':');
              topicName = splitArn[splitArn.length - 1];
            } else {
              topicName = event.sns;
            }
            tags = Object.assign({}, this._serverless.service.provider.tags);
            topicLogicalId = this._provider.naming.getTopicLogicalId(topicName)
            topics.push({ "logicalId": topicLogicalId, 'tags': tags });
          }
        } else if (event.schedule) {
          scheduleNumberInFunction++;

          let tags = Object.assign({}, this._serverless.service.provider.tags, event.schedule.tags);
          let scheduleLogicalId = this._provider.naming.getScheduleLogicalId(
            functionName,
            scheduleNumberInFunction
          );

          schedules.push({ "logicalId": scheduleLogicalId, 'tags': tags });

        } else {
          return;
        }

      });
      this._log(`${topics.length} topics found for tagging in serverless conf`);
      this._log(`${schedules.length} schedules found for tagging in serverless conf`);
    });

    /* Get the deployed SNS (mainly to get the arn for created Topics */
    this._provider
      .request('CloudFormation', 'describeStackResources', { StackName: stackName })
      .then(result => {
        if (result) {
          let partition = null;
          let region = null;
          let accountId = null;

          // Tagging SNS  - started
          let AWS_topics = result.StackResources.filter(a => { return a.ResourceType == "AWS::SNS::Topic" });
          this._log(`${AWS_topics.length} topics found into AWS`);
          AWS_topics.forEach(AWS_topic => {
            let topic = topics.find(t => { return t.logicalId == AWS_topic.LogicalResourceId });
            if (topic == undefined) {
              this._log("Not tag found for ${AWS_topic.LogicalResourceId}");
              return;
            }
            let tags = topic.tags;
            if (tags.length == 0) return;
            this._log(`Tagging ${AWS_topic.LogicalResourceId}`);
            this._provider.request('SNS', 'tagResource',
              {
                ResourceArn: AWS_topic.PhysicalResourceId,
                Tags: Object.keys(tags).map(k => ({ Key: k, Value: tags[k] }))
              });
          });
          this._serverless.cli.log("SNS tagging finished...");
          // Tagging SNS  - completed

          // Tagging Schedule  - started
          let AWS_schedules = result.StackResources.filter(a => { return a.ResourceType == "AWS::Events::Rule" });
          this._log(`${AWS_schedules.length} schedules found into AWS`);

          AWS_schedules.forEach(AWS_schedule => {
            let schedule = schedules.find(t => { return t.logicalId == AWS_schedule.LogicalResourceId });

            if (!partition || !region || !accountId) {
              let stackIdSplit = AWS_schedule.StackId.split(":");
              partition = stackIdSplit[1];
              region = stackIdSplit[3];
              accountId = stackIdSplit[4];
            }
            let tagArn = `arn:${partition}:events:${region}:${accountId}:rule/${AWS_schedule.PhysicalResourceId}`;

            if (schedule == undefined || schedule.tags.length == 0) {
              this._log(`Not tag found for ${tagArn}, hence performing cleaning of old tags(if exists)`);

              return ensureCleanedTagging(tagArn, this._provider, "EventBridge", {}, this._log);;
            } else {
              this._log(`Performing tagging on rule: ${tagArn}`);

              return ensureCleanedTagging(tagArn, this._provider, "EventBridge", schedule.tags, this._log);
            }
          });
          this._serverless.cli.log("Schedule tagging finished...");
          // Tagging Schedule  - completed

        }
      });
  }
}

module.exports = ServerlessPlugin;
