# OpenAI Proxy Docker
openai-proxy-docker provides an OpenAI API proxy server image by [Docker](https://hub.docker.com/r/shawnai/openai-proxy-docker)


## How to use
Just:

```shell
sudo docker run -d -p 9017:9017 shawnai/openai-proxy-docker:latest
```

Then, you can use it by ```YOURIP:9017```

> For example, the proxied OpenAI Chat Completion API will be: ```YOURIP:9017/v1/chat/completions```
> 
> It should be the same as ```api.openai.com/v1/chat/completions```

For detailed usage of OpenAI API, please check: [API Reference](https://platform.openai.com/docs/api-reference/introduction)

You can change default port and default target by setting `-e` in docker, which means that you can use it for any backend followed by OpenAPI format:
| Parameter | Default Value |
| ----- | ----- |
| PORT | 9017 |
| TARGET | https://api.openai.com |

If you want to check detailed about API, you can star my another repo [OpenApiWiki](https://github.com/k8rw/openapi-wiki) and [Demo](https://www.openapi.wiki/openai)

## How to maintain
Use PM2 to scale up this proxy application accross CPU(s):
- Listing managed processes
> ```shell
> docker exec -it <container-id> pm2 list
> ```
- Monitoring CPU/Usage of each process
> ```shell
> docker exec -it <container-id> pm2 monit
> ```
- 0sec downtime reload all applications
> ```shell
> docker exec -it <container-id> pm2 reload all
> ```

## How to dev

It can be easily modified by Github codespaces:
1. Fork this repo and create a codespace;
2. Wait for env ready in your browser;
3. `npm install ci`
4. `npm start`

And then, the codespace will provide a forward port (default 9017) for you to check the running.