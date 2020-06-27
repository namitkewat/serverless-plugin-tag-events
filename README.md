# serverless-plugin-tagsns

A serverless plugin to tag SNS Topics & Schedules on AWS

## Features

- Tag the sns topics & schedules
- Uses provider tags, events.sns tags, event.schedule tags

## Instalation

```bash
yarn add serverless-plugin-tag-events
```

then add it in your plugins list:

```yaml
plugins:
  - serverless-plugin-tag-events
```

## Tags Configuration

Using the tags configuration makes it possible to add key / value tags to your SNS Topic or Event schedule.

Those tags will appear in your AWS console and make it easier for you to group functions by tag or find functions with a common tag.

```yaml
functions:
  hello:
    handler: handler.hello
    events:
      - sns:
          topicName: aggregate
          displayName: Data aggregation pipeline
          tags:
              foo: bar
      - schedule:
          name: test
          description: 'test schedule'
          rate: rate(5 minutes)
          enabled: false
          input: '{}'
          tags:
            foo: bar
```

Or if you want to apply tags configuration to all topics/schedules in your service, you can add the configuration to the higher level provider object. Tags configured at the sns level are merged with those at the provider level, so your topic/schedule with specific tags will get the tags defined at the provider level. If a tag with the same key is defined at both the function and provider levels, the function-specific value overrides the provider-level default value. For example:

```yaml
# serverless.yml
service: service-name
provider:
  name: aws
  tags:
    foo: bar
    baz: qux
    envionment: development
functions:
  hello:
    handler: handler.hello
    events:
      - sns:
          topicName: aggregate
          displayName: Data aggregation pipeline
          tags:
              foo: quux
      - schedule:
          name: test
          description: 'test schedule'
          rate: rate(5 minutes)
          enabled: false
          input: '{}'
          tags:
            foo: bar
```

## License

MIT
