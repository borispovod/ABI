var Web3 = require("web3");
var SolidityEvent = require("web3/lib/web3/event.js");

(function() {
  // Planned for future features, logging, etc.
  function Provider(provider) {
    this.provider = provider;
  }

  Provider.prototype.send = function() {
    this.provider.send.apply(this.provider, arguments);
  };

  Provider.prototype.sendAsync = function() {
    this.provider.sendAsync.apply(this.provider, arguments);
  };

  var BigNumber = (new Web3()).toBigNumber(0).constructor;

  var Utils = {
    is_object: function(val) {
      return typeof val == "object" && !Array.isArray(val);
    },
    is_big_number: function(val) {
      if (typeof val != "object") return false;

      // Instanceof won't work because we have multiple versions of Web3.
      try {
        new BigNumber(val);
        return true;
      } catch (e) {
        return false;
      }
    },
    merge: function() {
      var merged = {};
      var args = Array.prototype.slice.call(arguments);

      for (var i = 0; i < args.length; i++) {
        var object = args[i];
        var keys = Object.keys(object);
        for (var j = 0; j < keys.length; j++) {
          var key = keys[j];
          var value = object[key];
          merged[key] = value;
        }
      }

      return merged;
    },
    promisifyFunction: function(fn, C) {
      var self = this;
      return function() {
        var instance = this;

        var args = Array.prototype.slice.call(arguments);
        var tx_params = {};
        var last_arg = args[args.length - 1];

        // It's only tx_params if it's an object and not a BigNumber.
        if (Utils.is_object(last_arg) && !Utils.is_big_number(last_arg)) {
          tx_params = args.pop();
        }

        tx_params = Utils.merge(C.class_defaults, tx_params);

        return new Promise(function(accept, reject) {
          var callback = function(error, result) {
            if (error != null) {
              reject(error);
            } else {
              accept(result);
            }
          };
          args.push(tx_params, callback);
          fn.apply(instance.contract, args);
        });
      };
    },
    synchronizeFunction: function(fn, instance, C) {
      var self = this;
      return function() {
        var args = Array.prototype.slice.call(arguments);
        var tx_params = {};
        var last_arg = args[args.length - 1];

        // It's only tx_params if it's an object and not a BigNumber.
        if (Utils.is_object(last_arg) && !Utils.is_big_number(last_arg)) {
          tx_params = args.pop();
        }

        tx_params = Utils.merge(C.class_defaults, tx_params);

        return new Promise(function(accept, reject) {

          var decodeLogs = function(logs) {
            return logs.map(function(log) {
              var logABI = C.events[log.topics[0]];

              if (logABI == null) {
                return null;
              }

              var decoder = new SolidityEvent(null, logABI, instance.address);
              return decoder.decode(log);
            }).filter(function(log) {
              return log != null;
            });
          };

          var callback = function(error, tx) {
            if (error != null) {
              reject(error);
              return;
            }

            var timeout = C.synchronization_timeout || 240000;
            var start = new Date().getTime();

            var make_attempt = function() {
              C.web3.eth.getTransactionReceipt(tx, function(err, receipt) {
                if (err) return reject(err);

                if (receipt != null) {
                  // If they've opted into next gen, return more information.
                  if (C.next_gen == true) {
                    return accept({
                      tx: tx,
                      receipt: receipt,
                      logs: decodeLogs(receipt.logs)
                    });
                  } else {
                    return accept(tx);
                  }
                }

                if (timeout > 0 && new Date().getTime() - start > timeout) {
                  return reject(new Error("Transaction " + tx + " wasn't processed in " + (timeout / 1000) + " seconds!"));
                }

                setTimeout(make_attempt, 1000);
              });
            };

            make_attempt();
          };

          args.push(tx_params, callback);
          fn.apply(self, args);
        });
      };
    }
  };

  function instantiate(instance, contract) {
    instance.contract = contract;
    var constructor = instance.constructor;

    // Provision our functions.
    for (var i = 0; i < instance.abi.length; i++) {
      var item = instance.abi[i];
      if (item.type == "function") {
        if (item.constant == true) {
          instance[item.name] = Utils.promisifyFunction(contract[item.name], constructor);
        } else {
          instance[item.name] = Utils.synchronizeFunction(contract[item.name], instance, constructor);
        }

        instance[item.name].call = Utils.promisifyFunction(contract[item.name].call, constructor);
        instance[item.name].sendTransaction = Utils.promisifyFunction(contract[item.name].sendTransaction, constructor);
        instance[item.name].request = contract[item.name].request;
        instance[item.name].estimateGas = Utils.promisifyFunction(contract[item.name].estimateGas, constructor);
      }

      if (item.type == "event") {
        instance[item.name] = contract[item.name];
      }
    }

    instance.allEvents = contract.allEvents;
    instance.address = contract.address;
    instance.transactionHash = contract.transactionHash;
  };

  // Use inheritance to create a clone of this contract,
  // and copy over contract's static functions.
  function mutate(fn) {
    var temp = function Clone() { return fn.apply(this, arguments); };

    Object.keys(fn).forEach(function(key) {
      temp[key] = fn[key];
    });

    temp.prototype = Object.create(fn.prototype);
    bootstrap(temp);
    return temp;
  };

  function bootstrap(fn) {
    fn.web3 = new Web3();
    fn.class_defaults  = fn.prototype.defaults || {};

    // Set the network iniitally to make default data available and re-use code.
    // Then remove the saved network id so the network will be auto-detected on first use.
    fn.setNetwork("default");
    fn.network_id = null;
    return fn;
  };

  // Accepts a contract object created with web3.eth.contract.
  // Optionally, if called without `new`, accepts a network_id and will
  // create a new version of the contract abstraction with that network_id set.
  function Contract() {
    if (this instanceof Contract) {
      instantiate(this, arguments[0]);
    } else {
      var C = mutate(Contract);
      var network_id = arguments.length > 0 ? arguments[0] : "default";
      C.setNetwork(network_id);
      return C;
    }
  };

  Contract.currentProvider = null;

  Contract.setProvider = function(provider) {
    var wrapped = new Provider(provider);
    this.web3.setProvider(wrapped);
    this.currentProvider = provider;
  };

  Contract.new = function() {
    if (this.currentProvider == null) {
      throw new Error("Wings error: Please call setProvider() first before calling new().");
    }

    var args = Array.prototype.slice.call(arguments);

    if (!this.unlinked_binary) {
      throw new Error("Wings error: contract binary not set. Can't deploy new instance.");
    }

    var regex = /__[^_]+_+/g;
    var unlinked_libraries = this.binary.match(regex);

    if (unlinked_libraries != null) {
      unlinked_libraries = unlinked_libraries.map(function(name) {
        // Remove underscores
        return name.replace(/_/g, "");
      }).sort().filter(function(name, index, arr) {
        // Remove duplicates
        if (index + 1 >= arr.length) {
          return true;
        }

        return name != arr[index + 1];
      }).join(", ");

      throw new Error("Wings contains unresolved libraries. You must deploy and link the following libraries before you can deploy a new version of Wings: " + unlinked_libraries);
    }

    var self = this;

    return new Promise(function(accept, reject) {
      var contract_class = self.web3.eth.contract(self.abi);
      var tx_params = {};
      var last_arg = args[args.length - 1];

      // It's only tx_params if it's an object and not a BigNumber.
      if (Utils.is_object(last_arg) && !Utils.is_big_number(last_arg)) {
        tx_params = args.pop();
      }

      tx_params = Utils.merge(self.class_defaults, tx_params);

      if (tx_params.data == null) {
        tx_params.data = self.binary;
      }

      // web3 0.9.0 and above calls new twice this callback twice.
      // Why, I have no idea...
      var intermediary = function(err, web3_instance) {
        if (err != null) {
          reject(err);
          return;
        }

        if (err == null && web3_instance != null && web3_instance.address != null) {
          accept(new self(web3_instance));
        }
      };

      args.push(tx_params, intermediary);
      contract_class.new.apply(contract_class, args);
    });
  };

  Contract.at = function(address) {
    if (address == null || typeof address != "string" || address.length != 42) {
      throw new Error("Invalid address passed to Wings.at(): " + address);
    }

    var contract_class = this.web3.eth.contract(this.abi);
    var contract = contract_class.at(address);

    return new this(contract);
  };

  Contract.deployed = function() {
    if (!this.address) {
      throw new Error("Cannot find deployed address: Wings not deployed or address not set.");
    }

    return this.at(this.address);
  };

  Contract.defaults = function(class_defaults) {
    if (this.class_defaults == null) {
      this.class_defaults = {};
    }

    if (class_defaults == null) {
      class_defaults = {};
    }

    var self = this;
    Object.keys(class_defaults).forEach(function(key) {
      var value = class_defaults[key];
      self.class_defaults[key] = value;
    });

    return this.class_defaults;
  };

  Contract.extend = function() {
    var args = Array.prototype.slice.call(arguments);

    for (var i = 0; i < arguments.length; i++) {
      var object = arguments[i];
      var keys = Object.keys(object);
      for (var j = 0; j < keys.length; j++) {
        var key = keys[j];
        var value = object[key];
        this.prototype[key] = value;
      }
    }
  };

  Contract.all_networks = {
  "default": {
    "abi": [
      {
        "constant": true,
        "inputs": [
          {
            "name": "id",
            "type": "bytes32"
          }
        ],
        "name": "getBaseProject",
        "outputs": [
          {
            "name": "projectId",
            "type": "bytes32"
          },
          {
            "name": "name",
            "type": "string"
          },
          {
            "name": "logoHash",
            "type": "bytes32"
          },
          {
            "name": "category",
            "type": "uint8"
          },
          {
            "name": "shortBlurb",
            "type": "bytes32"
          },
          {
            "name": "cap",
            "type": "bool"
          },
          {
            "name": "duration",
            "type": "uint256"
          },
          {
            "name": "goal",
            "type": "uint256"
          },
          {
            "name": "timestamp",
            "type": "uint256"
          }
        ],
        "payable": false,
        "type": "function"
      },
      {
        "constant": true,
        "inputs": [
          {
            "name": "id",
            "type": "bytes32"
          }
        ],
        "name": "getMilestonesCount",
        "outputs": [
          {
            "name": "",
            "type": "uint256"
          }
        ],
        "payable": false,
        "type": "function"
      },
      {
        "constant": true,
        "inputs": [
          {
            "name": "n",
            "type": "uint256"
          }
        ],
        "name": "getProjectId",
        "outputs": [
          {
            "name": "",
            "type": "bytes32"
          }
        ],
        "payable": false,
        "type": "function"
      },
      {
        "constant": false,
        "inputs": [
          {
            "name": "projectId",
            "type": "bytes32"
          }
        ],
        "name": "startCrowdsale",
        "outputs": [],
        "payable": false,
        "type": "function"
      },
      {
        "constant": true,
        "inputs": [
          {
            "name": "id",
            "type": "bytes32"
          }
        ],
        "name": "getProject",
        "outputs": [
          {
            "name": "projectId",
            "type": "bytes32"
          },
          {
            "name": "name",
            "type": "string"
          },
          {
            "name": "rewardType",
            "type": "uint8"
          },
          {
            "name": "rewardPercent",
            "type": "uint256"
          },
          {
            "name": "videolink",
            "type": "string"
          },
          {
            "name": "story",
            "type": "bytes32"
          },
          {
            "name": "creator",
            "type": "address"
          },
          {
            "name": "timestamp",
            "type": "uint256"
          }
        ],
        "payable": false,
        "type": "function"
      },
      {
        "constant": true,
        "inputs": [
          {
            "name": "id",
            "type": "bytes32"
          }
        ],
        "name": "getCap",
        "outputs": [
          {
            "name": "cap",
            "type": "uint256"
          }
        ],
        "payable": false,
        "type": "function"
      },
      {
        "constant": true,
        "inputs": [
          {
            "name": "id",
            "type": "bytes32"
          },
          {
            "name": "milestoneId",
            "type": "uint256"
          }
        ],
        "name": "getMilestone",
        "outputs": [
          {
            "name": "_type",
            "type": "uint8"
          },
          {
            "name": "amount",
            "type": "uint256"
          },
          {
            "name": "items",
            "type": "string"
          }
        ],
        "payable": false,
        "type": "function"
      },
      {
        "constant": false,
        "inputs": [
          {
            "name": "id",
            "type": "bytes32"
          },
          {
            "name": "to",
            "type": "address"
          }
        ],
        "name": "changeCreator",
        "outputs": [],
        "payable": false,
        "type": "function"
      },
      {
        "constant": false,
        "inputs": [
          {
            "name": "projectId",
            "type": "bytes32"
          },
          {
            "name": "sum",
            "type": "uint256"
          },
          {
            "name": "message",
            "type": "bytes32"
          }
        ],
        "name": "addForecast",
        "outputs": [],
        "payable": false,
        "type": "function"
      },
      {
        "constant": true,
        "inputs": [],
        "name": "getCount",
        "outputs": [
          {
            "name": "",
            "type": "uint256"
          }
        ],
        "payable": false,
        "type": "function"
      },
      {
        "constant": true,
        "inputs": [
          {
            "name": "projectId",
            "type": "bytes32"
          }
        ],
        "name": "getForecastCount",
        "outputs": [
          {
            "name": "",
            "type": "uint256"
          }
        ],
        "payable": false,
        "type": "function"
      },
      {
        "constant": true,
        "inputs": [
          {
            "name": "id",
            "type": "bytes32"
          }
        ],
        "name": "getMinimalGoal",
        "outputs": [
          {
            "name": "minimal",
            "type": "uint256"
          }
        ],
        "payable": false,
        "type": "function"
      },
      {
        "constant": true,
        "inputs": [
          {
            "name": "owner",
            "type": "address"
          }
        ],
        "name": "getMyProjectsCount",
        "outputs": [
          {
            "name": "",
            "type": "uint256"
          }
        ],
        "payable": false,
        "type": "function"
      },
      {
        "constant": true,
        "inputs": [
          {
            "name": "owner",
            "type": "address"
          },
          {
            "name": "id",
            "type": "uint256"
          }
        ],
        "name": "getMyProjectId",
        "outputs": [
          {
            "name": "",
            "type": "bytes32"
          }
        ],
        "payable": false,
        "type": "function"
      },
      {
        "constant": true,
        "inputs": [
          {
            "name": "projectId",
            "type": "bytes32"
          }
        ],
        "name": "getMyForecast",
        "outputs": [
          {
            "name": "_creator",
            "type": "address"
          },
          {
            "name": "_project",
            "type": "bytes32"
          },
          {
            "name": "_raiting",
            "type": "uint8"
          },
          {
            "name": "_timestamp",
            "type": "uint256"
          },
          {
            "name": "_message",
            "type": "bytes32"
          },
          {
            "name": "_sum",
            "type": "uint256"
          }
        ],
        "payable": false,
        "type": "function"
      },
      {
        "constant": false,
        "inputs": [
          {
            "name": "id",
            "type": "bytes32"
          },
          {
            "name": "_type",
            "type": "uint8"
          },
          {
            "name": "amount",
            "type": "uint256"
          },
          {
            "name": "_items",
            "type": "string"
          }
        ],
        "name": "addMilestone",
        "outputs": [],
        "payable": false,
        "type": "function"
      },
      {
        "constant": true,
        "inputs": [
          {
            "name": "projectId",
            "type": "bytes32"
          }
        ],
        "name": "getCrowdsale",
        "outputs": [
          {
            "name": "",
            "type": "address"
          },
          {
            "name": "",
            "type": "address"
          }
        ],
        "payable": false,
        "type": "function"
      },
      {
        "constant": true,
        "inputs": [
          {
            "name": "projectId",
            "type": "bytes32"
          },
          {
            "name": "id",
            "type": "uint256"
          }
        ],
        "name": "getForecast",
        "outputs": [
          {
            "name": "_creator",
            "type": "address"
          },
          {
            "name": "_project",
            "type": "bytes32"
          },
          {
            "name": "_raiting",
            "type": "uint8"
          },
          {
            "name": "_timestamp",
            "type": "uint256"
          },
          {
            "name": "_message",
            "type": "bytes32"
          },
          {
            "name": "sum",
            "type": "uint256"
          }
        ],
        "payable": false,
        "type": "function"
      },
      {
        "constant": false,
        "inputs": [
          {
            "name": "_name",
            "type": "string"
          },
          {
            "name": "_shortBlurb",
            "type": "bytes32"
          },
          {
            "name": "_logoHash",
            "type": "bytes32"
          },
          {
            "name": "_category",
            "type": "uint8"
          },
          {
            "name": "_rewardType",
            "type": "uint8"
          },
          {
            "name": "_rewardPercent",
            "type": "uint256"
          },
          {
            "name": "_duration",
            "type": "uint256"
          },
          {
            "name": "_goal",
            "type": "uint256"
          },
          {
            "name": "_videolink",
            "type": "string"
          },
          {
            "name": "_story",
            "type": "bytes32"
          },
          {
            "name": "cap",
            "type": "bool"
          }
        ],
        "name": "addProject",
        "outputs": [
          {
            "name": "",
            "type": "bool"
          }
        ],
        "payable": false,
        "type": "function"
      },
      {
        "inputs": [],
        "payable": false,
        "type": "constructor"
      },
      {
        "anonymous": false,
        "inputs": [
          {
            "indexed": true,
            "name": "creator",
            "type": "address"
          },
          {
            "indexed": true,
            "name": "id",
            "type": "bytes32"
          },
          {
            "indexed": false,
            "name": "name",
            "type": "string"
          }
        ],
        "name": "ProjectCreation",
        "type": "event"
      },
      {
        "anonymous": false,
        "inputs": [
          {
            "indexed": true,
            "name": "id",
            "type": "bytes32"
          },
          {
            "indexed": false,
            "name": "name",
            "type": "string"
          }
        ],
        "name": "ProjectReady",
        "type": "event"
      },
      {
        "anonymous": false,
        "inputs": [
          {
            "indexed": true,
            "name": "creator",
            "type": "bytes32"
          },
          {
            "indexed": true,
            "name": "id",
            "type": "bytes32"
          }
        ],
        "name": "ProjectPublishing",
        "type": "event"
      },
      {
        "anonymous": false,
        "inputs": [
          {
            "indexed": true,
            "name": "id",
            "type": "bytes"
          }
        ],
        "name": "MilestoneAdded",
        "type": "event"
      }
    ],
    "unlinked_binary": "0x606060405234610000575b60078054600160a060020a03191633600160a060020a03161790555b5b612e7b806100366000396000f30060606040523615620000ff5763ffffffff60e060020a6000350416630a226764811462000105578063289bbabc14620001ec5780633d932dfb14620002115780634270f59014620002365780634b5f748a146200024b5780634c2e5e9e146200039d5780637f6661c814620003c257806396244034146200047b5780639f07a198146200049c578063a87d942c14620004b7578063ae5dc73314620004d9578063b4ba3a9814620004fe578063b6ce88c51462000523578063d9bbfc3e1462000551578063e33c7bb91462000582578063ee977a7f14620005e4578063f0d3755f1462000645578063f1cc8006146200067e578063fa6203a114620006e3575b62000000565b34620000005762000118600435620007c3565b604080518a815290810188905260208101606082018860048111620000005760ff16815260208082018990528715156040830152606082018790526080820186905260a0820185905260c0848303810184528c51908301528b5160e090920191908c01908083838215620001a9575b805182526020831115620001a957601f19909201916020918201910162000187565b505050905090810190601f168015620001d65780820380516001836020036101000a031916815260200191505b509a505050505050505050505060405180910390f35b346200000057620001ff6004356200090a565b60408051918252519081900360200190f35b346200000057620001ff60043562000925565b60408051918252519081900360200190f35b346200000057620002496004356200093a565b005b3462000000576200025e60043562000b58565b6040805189815290602082019082018860028111620000005760ff168152602080820189905260608201879052600160a060020a038616608083015260a0820185905260c0848303810184528b51908301528a51604083019260e001918c01908083838215620002eb575b805182526020831115620002eb57601f199092019160209182019101620002c9565b505050905090810190601f168015620003185780820380516001836020036101000a031916815260200191505b5083810382528751815287516020918201918901908083838215620001a9575b805182526020831115620001a957601f19909201916020918201910162000187565b505050905090810190601f168015620001d65780820380516001836020036101000a031916815260200191505b509a505050505050505050505060405180910390f35b346200000057620001ff60043562000d07565b60408051918252519081900360200190f35b346200000057620003d860043560243562000d8f565b604051808460018111620000005760ff168152602001838152602001806020018281038252838181518152602001915080519060200190808383600083146200043e575b8051825260208311156200043e57601f1990920191602091820191016200041c565b505050905090810190601f1680156200046b5780820380516001836020036101000a031916815260200191505b5094505050505060405180910390f35b34620000005762000249600435600160a060020a036024351662000ef3565b005b3462000000576200024960043560243560443562000f55565b005b346200000057620001ff62001178565b60408051918252519081900360200190f35b346200000057620001ff6004356200117f565b60408051918252519081900360200190f35b346200000057620001ff6004356200119a565b60408051918252519081900360200190f35b346200000057620001ff600160a060020a0360043516620011f6565b60408051918252519081900360200190f35b346200000057620001ff600160a060020a036004351660243562001215565b60408051918252519081900360200190f35b3462000000576200059560043562001240565b60408051600160a060020a0388168152602081018790529081018560018111620000005760ff168152602081019490945250604080840192909252606083015251908190036080019350915050f35b346200000057604080516020600460643581810135601f810184900484028501840190955284845262000249948235946024803560ff169560443595946084949201919081908401838280828437509496506200129a95505050505050565b005b34620000005762000658600435620015f9565b60408051600160a060020a03938416815291909216602082015281519081900390910190f35b3462000000576200059560043560243562001624565b60408051600160a060020a0388168152602081018790529081018560018111620000005760ff168152602081019490945250604080840192909252606083015251908190036080019350915050f35b346200000057620007af600480803590602001908201803590602001908080601f016020809104026020016040519081016040528093929190818152602001838380828437505060408051602060e08901358a018035601f81018390048302840183018552808452989a8a359a808401359a9581013560ff9081169a5060608201351698506080810135975060a0810135965060c08101359591946101009091019390928101919081908401838280828437509496505084359460200135151593506200168092505050565b604080519115158252519081900360200190f35b6000602060405190810160405280600081525060006000600060006000600060006000600060008c60001916600019168152602001908152602001600020905080600001548160010182600301548360040160009054906101000a900460ff16846002015485600c0160009054906101000a900460ff168660060154876007015488600b0154878054600181600116156101000203166002900480601f016020809104026020016040519081016040528092919081815260200182805460018160011615610100020316600290048015620008e25780601f10620008b657610100808354040283529160200191620008e2565b820191906000526020600020905b815481529060010190602001808311620008c457829003601f168201915b505050505097509950995099509950995099509950995099505b509193959799909294969850565b6000818152602081905260409020600d810154905b50919050565b6000818152600160205260409020545b919050565b6040805160608101825260008082526020808301829052828401829052848252819052918220600a810154839291859133600160a060020a039081169116141562000b4f5760008681526005602052604090208054879190600160a060020a0316151562000b4a5760008881526020819052604090819020905190975060018801908190610d0a8062002146833960409101818152835460026000196101006001841615020190911604918101829052908190602082019060608301908690801562000a4a5780601f1062000a1e5761010080835404028352916020019162000a4a565b820191906000526020600020905b81548152906001019060200180831162000a2c57829003601f168201915b505083810382528454600260001961010060018416150201909116048082526020909101908590801562000ac25780601f1062000a965761010080835404028352916020019162000ac2565b820191906000526020600020905b81548152906001019060200180831162000aa457829003601f168201915b5050945050505050604051809103906000f08015620000005760408051606081018252600160a060020a03338116825260208083018d815282861684860190815260008f815260059093529490912083518154908416600160a060020a0319918216178255915160018201559351600290940180549490921693169290921790915590965094505b5b5b50505b5b505050505050565b60408051602080820183526000808352835180830185528181528582528183528482208054600482015460058301546009840154600a850154600b860154600180880180548e5160026000196101009584161586020190921691909104601f81018e90048e0282018e01909f528e81529a9d8e9c8d9c8d9b8c9b8c9b919a909995989690910460ff1696909560088b019594600160a060020a039091169391929189919083018282801562000c515780601f1062000c255761010080835404028352916020019162000c51565b820191906000526020600020905b81548152906001019060200180831162000c3357829003601f168201915b5050875460408051602060026001851615610100026000190190941693909304601f8101849004840282018401909252818152959c508994509250840190508282801562000ce35780601f1062000cb75761010080835404028352916020019162000ce3565b820191906000526020600020905b81548152906001019060200180831162000cc557829003601f168201915b50505050509350985098509850985098509850985098505b50919395975091939597565b6000818152602081905260408120600a81015482908190600160a060020a0316158062000d395750600c83015460ff16155b1562000d455762000000565b5060009050805b82600d01548160ff16101562000d835760ff81166000908152600f8401602052604090206002015491909101905b60010162000d4c565b8193505b505050919050565b604080516020818101835260008083528351808301855281815286825291819052928320600a8101548493928491600160a060020a0316151562000dd35762000000565b82600f016000888152602001908152602001600020915062000ed082600301805480602002602001604051908101604052809291908181526020016000905b8282101562000ec6576000848152602081208301905b50805460408051602060026001851615610100026000190190941693909304601f8101849004840282018401909252818152929183018282801562000eb15780601f1062000e855761010080835404028352916020019162000eb1565b820191906000526020600020905b81548152906001019060200180831162000e9357829003601f168201915b50505050508152602001906001019062000e12565b5050505062001c05565b6001830154600284015460ff9091169750955093508390505b5050509250925092565b6000828152602081905260408120600a81015484919033600160a060020a039081169116141562000f4c576000858152602081905260409020600a81018054600160a060020a031916600160a060020a03871617905592505b5b5b5050505050565b6040805160c08101825260008082526020808301829052828401829052606083018290526080830182905260a08301829052868252819052918220600a8101549092918291600160a060020a0316151562000fb05762000000565b600160a060020a0333811660009081526004602090815260408083208b8452909152902054161562000fe25762000000565b836007015486111562000ff55762000000565b600784015460029004925060009150828611156200101257600191505b6040805160c081018252600160a060020a0333168152602081018990529081018360018111620000005781524260208083019190915260408083018990526060909201899052600e870180546001808201909255600090815260108901835283902084518154600160a060020a031916600160a060020a03909116178155918401518282015591830151600282018054949550859492939192909160ff1990911690838181116200000057021790555060608201516003820155608082015160048083019190915560a09092015160059091015533600160a060020a039081166000908152602092835260408082208b835284529081902084518154600160a060020a03191693169290921782559183015160018083019190915591830151600282018054859460ff19909116908381811162000000570217905550606082015160038201556080820151600482015560a0909101516005909101555b50505050505050565b6006545b90565b6000818152602081905260409020600e810154905b50919050565b6000818152602081905260408120600a810154600160a060020a03161515620011c35762000000565b600d8101541515620011d957600091506200091f565b6000808052600f8201602052604090206002015491505b50919050565b600160a060020a0381166000908152600360205260409020545b919050565b600160a060020a03821660009081526002602090815260408083208484529091529020545b92915050565b600160a060020a03338116600090815260046020818152604080842086855290915290912080546001820154600283015460038401549484015460058501549390961695919460ff909116939092905b5091939550919395565b60408051602080820183526000808352835160808101855281815280830182905280850182905284518084018652828152606082015288825291819052928320600a810154849384938493919290918b9133600160a060020a0390811691161415620015ea5760008c8152602081905260409020600b8101548d91906201518001421015620015e55760008e8152602081905260409020600a810154909a50600160a060020a0316158062001353575089600d0154600a145b806200135d57508b155b15620013695762000000565b60009850600097505b89600d01548860ff161015620013ac5760ff88166000908152600f8b01602052604090206002015498909801975b60019097019662001372565b888a600701540396508b871015620013c45762000000565b620013cf8b62001cd6565b9550600a86511180620013e157508551155b15620013ed5762000000565b60408051608081019091528e8152602081018e600181116200000057815260208082018f90526040918201899052600d8d01805460018082019092556000908152600f8f0183529290922083518155908301518183018054949950899492939192909160ff199091169083818111620000005702179055506040820151816002015560608201518160030190805190602001908280548282559060005260206000209081019282156200155e579160200282015b828111156200155e578251829080519060200190828054600181600116156101000203166002900490600052602060002090601f016020900481019282601f10620014f857805160ff191683800117855562001528565b8280016001018555821562001528579182015b82811115620015285782518255916020019190600101906200150b565b5b506200154c9291505b8082111562001548576000815560010162001532565b5090565b505091602001919060010190620014a1565b5b50620015e09291505b808211156200154857600081805460018160011615610100020316600290046000825580601f106200159b5750620015d0565b601f016020900490600052602060002090810190620015d091905b8082111562001548576000815560010162001532565b5090565b5b505060010162001568565b5090565b505050505b5b5b50505b5b505050505050505050505050565b600081815260056020526040902080546002820154600160a060020a03918216929116905b50915091565b60008281526020818152604080832084845260108101909252909120805460018201546002830154600384015460048501546005860154600160a060020a0390951696939560ff90931694919390925b50509295509295509295565b6040805161020081018252600080825282516020818101855282825283015291810182905260608101829052819060808101828152602001600081526020016000815260200160008152602001600081526020016020604051908101604052806000815250815260200160006000191681526020016000600160a060020a031681526020016000815260200160001515815260200160008152602001600081525060028e6000604051602001526040518082805190602001908083835b602083106200175e5780518252601f1990920191602091820191016200173d565b51815160209384036101000a600019018019909216911617905260405191909301945091925050808303816000866161da5a03f1156200000057505060408051516000818152602081905291909120600a0154909250600160a060020a031615620017c95762000000565b6064891180620017d7575088155b15620017e35762000000565b60b4881180620017f35750601e88105b15620017ff5762000000565b61020060405190810160405280836000191681526020018f81526020018e6000191681526020018d6000191681526020018c60048111620000005781526020018b60028111620000005781526020018a81526020018981526020018881526020018781526020018660001916815260200133600160a060020a031681526020014281526020018515158152602001600081526020016000815250905080600060008460001916600019168152602001908152602001600020600082015181600001906000191690556020820151816001019080519060200190828054600181600116156101000203166002900490600052602060002090601f016020900481019282601f106200191b57805160ff19168380011785556200194b565b828001600101855582156200194b579182015b828111156200194b5782518255916020019190600101906200192e565b5b506200196f9291505b8082111562001548576000815560010162001532565b5090565b50506040820151600282015560608201516003820155608082015160048083018054909160ff1990911690600190849081116200000057021790555060a082015160048201805461ff00191661010083600281116200000057021790555060c0820151816005015560e082015181600601556101008201518160070155610120820151816008019080519060200190828054600181600116156101000203166002900490600052602060002090601f016020900481019282601f1062001a4157805160ff191683800117855562001a71565b8280016001018555821562001a71579182015b8281111562001a7157825182559160200191906001019062001a54565b5b5062001a959291505b8082111562001548576000815560010162001532565b5090565b50506101408201516009820155610160820151600a82018054600160a060020a031916600160a060020a03928316179055610180830151600b8301556101a0830151600c8301805460ff19169115159190911790556101c0830151600d8301556101e090920151600e909101556006805460018181019092556000908152602082815260408083208790553390941680835260028252848320600383528584208054958601905593835292815290839020859055838101518351828152815181840152815187957fb51137fa4576a20eb8718cc01e8c7821ebb385866a7d9e12dcc1d2edd0792c869483929183019190850190808383821562001bb5575b80518252602083111562001bb557601f19909201916020918201910162001b93565b505050905090810190601f16801562001be25780820380516001836020036101000a031916815260200191505b509250505060405180910390a3600192505b50509b9a5050505050505050505050565b6040805160208181018352600080835283518083018552819052835191820190935282815290915b83518160ff16101562001ccb5762001c7962001c61858360ff16815181101562000000579060200190602002015162001e06565b62001c6c8462001e06565b9063ffffffff62001e3616565b915062001cbf62001c616040604051908101604052806001815260200160f960020a60050281525062001e06565b62001c6c8462001e06565b9063ffffffff62001e3616565b91505b60010162001c2d565b8192505b5050919050565b60408051602081810183526000808352835180850185528181528083018290528451808601865282815280840183905285519384019095528183529293919062001d208662001e06565b935062001d4a6040604051908101604052806001815260200160f960020a60050281525062001e06565b925062001d5e848463ffffffff62001ebc16565b60405180591062001d6c5750595b90808252806020026020018201604052801562001dab57816020015b60408051602081810190925260008152825260001990920191018162001d885790505b509150600090505b815181101562001df95762001dd962001dd3858563ffffffff62001f3116565b62001f5a565b828281518110156200000057602090810290910101525b60010162001db3565b8194505b50505050919050565b60408051808201825260008082526020918201528151808301909252825182528281019082018190525b50919050565b6040805160208181018352600080835283519182018452808252845186519451939492939192019080591062001e695750595b908082528060200260200182016040525b50915060208201905062001e98818660200151876000015162001fcb565b84516020850151855162001eb0928401919062001fcb565b8192505b505092915050565b60006000826000015162001ee3856000015186602001518660000151876020015162002016565b0190505b8351602085015101811162001f2957825160208086015186519186015160019095019462001f2092918503909103908490849062002016565b01905062001ee7565b5b5092915050565b604080518082019091526000808252602082015262001f29838383620020c6565b505b92915050565b602060405190810160405280600081525060206040519081016040528060008152506000836000015160405180591062001f915750595b908082528060200260200182016040525b50915060208201905062001ccb818560200151866000015162001fcb565b8192505b5050919050565b60005b6020821062001ff25782518452602093840193909201915b60208203915062001fce565b6001826020036101000a039050801983511681855116818117865250505b50505050565b600080808080888711620020b25760208711620020725760018760200360080260020a031980875116888b038a018a96505b8183885116146200206657600187019681901062002048578b8b0196505b505050839450620020ba565b8686209150879350600092505b8689038311620020b25750858320818114156200209f57839450620020ba565b6001840193505b6001909201916200207f565b5b5b88880194505b50505050949350505050565b6040805180820190915260008082526020808301829052855186820151865192870151620020f5939062002016565b6020808701805191860191909152805182038552865190519192500181141562002123576000855262002139565b8351835186519101900385528351810160208601525b8291505b509392505050560060a0604052600e60608190527f43726f776473616c65546f6b656e00000000000000000000000000000000000060809081526003805460008290527f43726f776473616c65546f6b656e00000000000000000000000000000000001c825590927fc2575a0e9e593c00f959f8c92f12db2869c3395a3b0502d05e2516446f71f85b602060026001851615610100026000190190941693909304601f0192909204820192909190620000db565b82800160010185558215620000db579182015b82811115620000db578251825591602001919060010190620000be565b5b50620000ff9291505b80821115620000fb5760008155600101620000e5565b5090565b50506040805180820190915260038082527f435257000000000000000000000000000000000000000000000000000000000060209283019081526004805460008290528251600660ff1990911617825590937f8a35acfbc15ff81a39ae7d344fd709f28e8600b4aa8c65c6b64bfe7fe36bd19b60026001841615610100026000190190931692909204601f010481019291620001c6565b82800160010185558215620001c6579182015b82811115620001c6578251825591602001919060010190620001a9565b5b50620001ea9291505b80821115620000fb5760008155600101620000e5565b5090565b505060126005556101f46006556040805160208082019283905260009182905260078054818452845160ff1916825590937fa66cc928b5edb82af9bd49922954155ab7b0942694bea4ce44661d9a8736c68860026001841615610100026000190190931692909204601f01929092048101929162000293565b8280016001018555821562000293579182015b828111156200029357825182559160200191906001019062000276565b5b50620002b79291505b80821115620000fb5760008155600101620000e5565b5090565b50506040805160208082019283905260009182905260088054818452845160ff1916825590937ff3f7a9fe364faab93b216da50a3214154f22a0a2b415b23a84c8169e8b636ee360026001841615610100026000190190931692909204601f01929092048101929162000355565b8280016001018555821562000355579182015b828111156200035557825182559160200191906001019062000338565b5b50620003799291505b80821115620000fb5760008155600101620000e5565b5090565b505034620000005760405162000d0a38038062000d0a833981016040528051602082015190820191015b8160079080519060200190828054600181600116156101000203166002900490600052602060002090601f016020900481019282601f10620003f157805160ff191683800117855562000421565b8280016001018555821562000421579182015b828111156200042157825182559160200191906001019062000404565b5b50620004459291505b80821115620000fb5760008155600101620000e5565b5090565b50508060089080519060200190828054600181600116156101000203166002900490600052602060002090601f016020900481019282601f106200049557805160ff1916838001178555620004c5565b82800160010185558215620004c5579182015b82811115620004c5578251825591602001919060010190620004a8565b5b50620004e99291505b80821115620000fb5760008155600101620000e5565b5090565b50505b50505b61080b80620004ff6000396000f3006060604052361561009e5763ffffffff60e060020a60003504166306fdde0381146100b0578063095ea7b31461013d57806318160ddd1461016d57806323b872dd1461018c578063313ce567146101c257806370a08231146101e1578063775a25e31461020c57806395d89b411461022b57806398d5fdca146102b8578063a9059cbb146102d7578063cedbbeee14610307578063dd62ed3e1461031d575b6100ae5b6100ab3361034e565b5b565b005b34610000576100bd6103be565b604080516020808252835181830152835191928392908301918501908083838215610103575b80518252602083111561010357601f1990920191602091820191016100e3565b505050905090810190601f16801561012f5780820380516001836020036101000a031916815260200191505b509250505060405180910390f35b3461000057610159600160a060020a036004351660243561044c565b604080519115158252519081900360200190f35b346100005761017a6104b7565b60408051918252519081900360200190f35b3461000057610159600160a060020a03600435811690602435166044356104bd565b604080519115158252519081900360200190f35b346100005761017a6105c0565b60408051918252519081900360200190f35b346100005761017a600160a060020a03600435166105c6565b60408051918252519081900360200190f35b346100005761017a6105e5565b60408051918252519081900360200190f35b34610000576100bd6105ec565b604080516020808252835181830152835191928392908301918501908083838215610103575b80518252602083111561010357601f1990920191602091820191016100e3565b505050905090810190601f16801561012f5780820380516001836020036101000a031916815260200191505b509250505060405180910390f35b346100005761017a61067a565b60408051918252519081900360200190f35b3461000057610159600160a060020a0360043516602435610681565b604080519115158252519081900360200190f35b6100ae600160a060020a036004351661034e565b005b346100005761017a600160a060020a0360043581169060243516610735565b60408051918252519081900360200190f35b600034151561035c57610000565b61036d3461036861067a565b610762565b905061037b6000548261078e565b6000908155600160a060020a0383168152600160205260409020546103a0908261078e565b600160a060020a0383166000908152600160205260409020555b5050565b6007805460408051602060026001851615610100026000190190941693909304601f810184900484028201840190925281815292918301828280156104445780601f1061041957610100808354040283529160200191610444565b820191906000526020600020905b81548152906001019060200180831161042757829003601f168201915b505050505081565b600160a060020a03338116600081815260026020908152604080832094871680845294825280832086905580518681529051929493927f8c5be1e5ebec7d5bd14f71427d1e84f3dd0314c0f7b2291e5b200ac8c7c3b925929181900390910190a35060015b92915050565b60005481565b600160a060020a0380841660009081526002602090815260408083203385168452825280832054938616835260019091528120549091906104fe908461078e565b600160a060020a03808616600090815260016020526040808220939093559087168152205461052d90846107b6565b600160a060020a03861660009081526001602052604090205561055081846107b6565b600160a060020a038087166000818152600260209081526040808320338616845282529182902094909455805187815290519288169391927fddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef929181900390910190a3600191505b509392505050565b60055481565b600160a060020a0381166000908152600160205260409020545b919050565b6000545b90565b6008805460408051602060026001851615610100026000190190941693909304601f810184900484028201840190925281815292918301828280156104445780601f1061041957610100808354040283529160200191610444565b820191906000526020600020905b81548152906001019060200180831161042757829003601f168201915b505050505081565b6006545b90565b600160a060020a0333166000908152600160205260408120546106a490836107b6565b600160a060020a0333811660009081526001602052604080822093909355908516815220546106d3908361078e565b600160a060020a038085166000818152600160209081526040918290209490945580518681529051919333909316927fddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef92918290030190a35060015b92915050565b600160a060020a038083166000908152600260209081526040808320938516835292905220545b92915050565b600082820261078384158061077e575083858381156100005704145b6107cf565b8091505b5092915050565b600082820161078384821080159061077e5750838210155b6107cf565b8091505b5092915050565b60006107c4838311156107cf565b508082035b92915050565b8015156107db57610000565b5b505600a165627a7a7230582073c170201757c3f0a27ba050a76e97597d1bb2e0884b052a61f87f4bae7108b60029a165627a7a7230582097fabf8a01536d78aeed3c72b3e623591e3e00e5e1398a2acdd02cbce38f20b30029",
    "events": {
      "0xb51137fa4576a20eb8718cc01e8c7821ebb385866a7d9e12dcc1d2edd0792c86": {
        "anonymous": false,
        "inputs": [
          {
            "indexed": true,
            "name": "creator",
            "type": "address"
          },
          {
            "indexed": true,
            "name": "id",
            "type": "bytes32"
          },
          {
            "indexed": false,
            "name": "name",
            "type": "string"
          }
        ],
        "name": "ProjectCreation",
        "type": "event"
      },
      "0x41c2d757f4175ca1985cd9d15b7e502800667b4addab285c96e652e177d44ebc": {
        "anonymous": false,
        "inputs": [
          {
            "indexed": true,
            "name": "id",
            "type": "bytes32"
          },
          {
            "indexed": false,
            "name": "name",
            "type": "string"
          }
        ],
        "name": "ProjectReady",
        "type": "event"
      },
      "0xaf4e99c2ca761f043dc501f64bd8ba18776f4fe4cfe04e082a31515177bcbc51": {
        "anonymous": false,
        "inputs": [
          {
            "indexed": true,
            "name": "creator",
            "type": "bytes32"
          },
          {
            "indexed": true,
            "name": "id",
            "type": "bytes32"
          }
        ],
        "name": "ProjectPublishing",
        "type": "event"
      },
      "0x0cd155a83dd66a99f0399cd812566c6bcb6c61b42334a586f0e4d13b3e8193e4": {
        "anonymous": false,
        "inputs": [
          {
            "indexed": true,
            "name": "id",
            "type": "bytes"
          }
        ],
        "name": "MilestoneAdded",
        "type": "event"
      }
    },
    "updated_at": 1483145661405,
    "links": {},
    "address": "0x13ec53ac8e68bf4131c17c5431ca3b91ba37b873"
  }
};

  Contract.checkNetwork = function(callback) {
    var self = this;

    if (this.network_id != null) {
      return callback();
    }

    this.web3.version.network(function(err, result) {
      if (err) return callback(err);

      var network_id = result.toString();

      // If we have the main network,
      if (network_id == "1") {
        var possible_ids = ["1", "live", "default"];

        for (var i = 0; i < possible_ids.length; i++) {
          var id = possible_ids[i];
          if (Contract.all_networks[id] != null) {
            network_id = id;
            break;
          }
        }
      }

      if (self.all_networks[network_id] == null) {
        return callback(new Error(self.name + " error: Can't find artifacts for network id '" + network_id + "'"));
      }

      self.setNetwork(network_id);
      callback();
    })
  };

  Contract.setNetwork = function(network_id) {
    var network = this.all_networks[network_id] || {};

    this.abi             = this.prototype.abi             = network.abi;
    this.unlinked_binary = this.prototype.unlinked_binary = network.unlinked_binary;
    this.address         = this.prototype.address         = network.address;
    this.updated_at      = this.prototype.updated_at      = network.updated_at;
    this.links           = this.prototype.links           = network.links || {};
    this.events          = this.prototype.events          = network.events || {};

    this.network_id = network_id;
  };

  Contract.networks = function() {
    return Object.keys(this.all_networks);
  };

  Contract.link = function(name, address) {
    if (typeof name == "function") {
      var contract = name;

      if (contract.address == null) {
        throw new Error("Cannot link contract without an address.");
      }

      Contract.link(contract.contract_name, contract.address);

      // Merge events so this contract knows about library's events
      Object.keys(contract.events).forEach(function(topic) {
        Contract.events[topic] = contract.events[topic];
      });

      return;
    }

    if (typeof name == "object") {
      var obj = name;
      Object.keys(obj).forEach(function(name) {
        var a = obj[name];
        Contract.link(name, a);
      });
      return;
    }

    Contract.links[name] = address;
  };

  Contract.contract_name   = Contract.prototype.contract_name   = "Wings";
  Contract.generated_with  = Contract.prototype.generated_with  = "3.2.0";

  // Allow people to opt-in to breaking changes now.
  Contract.next_gen = false;

  var properties = {
    binary: function() {
      var binary = Contract.unlinked_binary;

      Object.keys(Contract.links).forEach(function(library_name) {
        var library_address = Contract.links[library_name];
        var regex = new RegExp("__" + library_name + "_*", "g");

        binary = binary.replace(regex, library_address.replace("0x", ""));
      });

      return binary;
    }
  };

  Object.keys(properties).forEach(function(key) {
    var getter = properties[key];

    var definition = {};
    definition.enumerable = true;
    definition.configurable = false;
    definition.get = getter;

    Object.defineProperty(Contract, key, definition);
    Object.defineProperty(Contract.prototype, key, definition);
  });

  bootstrap(Contract);

  if (typeof module != "undefined" && typeof module.exports != "undefined") {
    module.exports = Contract;
  } else {
    // There will only be one version of this contract in the browser,
    // and we can use that.
    window.Wings = Contract;
  }
})();
