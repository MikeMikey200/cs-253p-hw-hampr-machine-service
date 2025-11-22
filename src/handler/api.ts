import { DataCache } from "../database/cache";
import { MachineStateTable } from "../database/table";
import { IdentityProviderClient } from "../external/idp";
import { SmartMachineClient } from "../external/smart-machine";
import { GetMachineRequestModel, HttpResponseCode, MachineResponseModel, RequestMachineRequestModel, RequestModel, StartMachineRequestModel } from "./model";
import { MachineStateDocument, MachineStatus } from "../database/schema";
/**
 * Handles API requests for machine operations.
 * This class is responsible for routing requests to the appropriate handlers
 * and managing the overall workflow of machine interactions.
 */
export class ApiHandler {
    private cache: DataCache<MachineStateDocument>;
    constructor() {
        this.cache = DataCache.getInstance<MachineStateDocument>();
    }

    /**
     * Validates an authentication token.
     * @param token The token to validate.
     * @throws An error if the token is invalid.
     */
    private checkToken(token: string) {
        const identityPC = IdentityProviderClient.getInstance();

        if (token.length === 0 || !token) {
            throw "{\"statusCode\":" + HttpResponseCode.NOT_FOUND + ",\"message\":\"Token not found\"}";
        }

        if (!identityPC.validateToken(token)) {
            throw "{\"statusCode\":" + HttpResponseCode.UNAUTHORIZED + ",\"message\":\"Invalid token\"}";
        }
    }

    /**
     * Handles a request to find and reserve an available machine at a specific location.
     * It finds an available machine, updates its status to AWAITING_DROPOFF,
     * assigns the job ID, and caches the updated machine state.
     * NOTE: The current implementation assumes a machine will be held for a certain period,
     * but there is no mechanism to release the hold if the user doesn't proceed.
     * @param request The request model containing location and job IDs.
     * @returns A response model with the status code and the reserved machine's state.
     */
    private handleRequestMachine(request: RequestMachineRequestModel): MachineResponseModel {
        const machineTable = MachineStateTable.getInstance();
        const machineArr = machineTable.listMachinesAtLocation(request.locationId);
        let machineAvailable = null;

        // find the first available machine
        for (const machine of machineArr) {
            if (machine.status === MachineStatus.AVAILABLE) {
                machineAvailable = machine;
                break;
            }
        }

        // no machine available at this location
        if (!machineAvailable) {
            return {
                statusCode: HttpResponseCode.NOT_FOUND,
                machine: undefined
            };
        }

        // update status to machine, cache, and database and assign the machine job
        machineAvailable.status = MachineStatus.AWAITING_DROPOFF;
        machineAvailable.currentJobId = request.jobId;
        machineTable.updateMachineJobId(machineAvailable.machineId, request.jobId);
        machineTable.updateMachineStatus(machineAvailable.machineId, MachineStatus.AWAITING_DROPOFF);
        this.cache.put(machineAvailable.machineId, machineAvailable);

        return {
            statusCode: HttpResponseCode.OK,
            machine: machineAvailable
        };
    }

    /**
     * Retrieves the state of a specific machine.
     * It first checks the cache for the machine's data and, if not found, fetches it from the database.
     * @param request The request model containing the machine ID.
     * @returns A response model with the status code and the machine's state.
     */
    private handleGetMachine(request: GetMachineRequestModel): MachineResponseModel {
        let machine = this.cache.get(request.machineId);

        // is it in the cache?
        if (machine) {
            return {
                statusCode: HttpResponseCode.OK,
                machine: machine
            };
        }

        // grabbing machine from database
        const machineTable = MachineStateTable.getInstance();
        machine = machineTable.getMachine(request.machineId);
        
        // is it in the database?
        if (!machine) {
            return {
                statusCode: HttpResponseCode.NOT_FOUND,
                machine: undefined
            };
        }

        // store in cache
        this.cache.put(request.machineId, machine);

        return {
            statusCode: HttpResponseCode.OK,
            machine: machine
        };
    }

    /**
     * Starts the cycle of a machine that is awaiting drop-off.
     * It validates the machine's status, calls the external Smart Machine API to start the cycle,
     * and updates the machine's status to RUNNING.
     * @param request The request model containing the machine ID.
     * @returns A response model with the status code and the updated machine's state.
     */
    private handleStartMachine(request: StartMachineRequestModel): MachineResponseModel {
        const machineTable = MachineStateTable.getInstance();
        // check cache
        let machine = this.cache.get(request.machineId);
        
        if (!machine) {
            // check database
            machine = machineTable.getMachine(request.machineId);
        }

        if (!machine) {
            return {
                statusCode: HttpResponseCode.NOT_FOUND,
                machine: undefined
            };
        }

        // validate status
        if (machine.status !== MachineStatus.AWAITING_DROPOFF) {
            return {
                statusCode: HttpResponseCode.BAD_REQUEST,
                machine: machine
            };
        }

        // smart client to start machine
        try {
            const smartClient = SmartMachineClient.getInstance();
            smartClient.startCycle(request.machineId);

            const runningMachine = { ...machine, status: MachineStatus.RUNNING };

            // update the database and cache
            machineTable.updateMachineStatus(request.machineId, MachineStatus.RUNNING);
            this.cache.put(request.machineId, runningMachine);

            return {
                statusCode: HttpResponseCode.OK,
                machine: runningMachine
            };
        }
        catch (error) {
            const errorMachine = { ...machine, status: MachineStatus.ERROR };
            machineTable.updateMachineStatus(request.machineId, MachineStatus.ERROR);
            this.cache.put(request.machineId, errorMachine);

            return {
                statusCode: HttpResponseCode.HARDWARE_ERROR,
                machine: errorMachine
            }
        }
    }

    /**
     * The main entry point for handling all API requests.
     * It validates the token and routes the request to the appropriate private handler based on the method and path.
     * @param request The incoming request model.
     * @returns A response model from one of the specific handlers, or an error response.
     */
    public handle(request: RequestModel) {
        this.checkToken(request.token);

        if (request.method === 'POST' && request.path === '/machine/request') {
            return this.handleRequestMachine(request as RequestMachineRequestModel);
        }

        const getMachineMatch = request.path.match(/^\/machine\/([a-zA-Z0-9-]+)$/);
        if (request.method === 'GET' && getMachineMatch) {
            const machineId = getMachineMatch[1];
            const getRequest = { ...request, machineId } as GetMachineRequestModel;
            return this.handleGetMachine(getRequest);
        }

        const startMachineMatch = request.path.match(/^\/machine\/([a-zA-Z0-9-]+)\/start$/);
        if (request.method === 'POST' && startMachineMatch) { 
            const machineId = startMachineMatch[1];
            const startRequest = { ...request, machineId } as StartMachineRequestModel;
            return this.handleStartMachine(startRequest);
        }

        return { statusCode: HttpResponseCode.INTERNAL_SERVER_ERROR, machine: null };
    }
    
}