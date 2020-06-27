'use strict';

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
            if (schedule == undefined) {
              this._log("Not tag found for ${AWS_schedule.LogicalResourceId}");
              return;
            }
            let tags = schedule.tags;
            if (tags.length == 0) return;

            if (!partition || !region || !accountId) {
              let stackIdSplit = AWS_schedule.StackId.split(":");
              partition = stackIdSplit[1];
              region = stackIdSplit[3];
              accountId = stackIdSplit[4];
            }

            let tagArn = `arn:${partition}:events:${region}:${accountId}:rule/${AWS_schedule.PhysicalResourceId}`;
            this._provider.request('EventBridge', 'tagResource',
              {
                ResourceARN: tagArn,
                Tags: Object.keys(tags).map(k => ({ Key: k, Value: tags[k] }))
              });
          });
          this._serverless.cli.log("Schedule tagging finished...");
          // Tagging Schedule  - completed

        }
      });
  }
}

module.exports = ServerlessPlugin;
